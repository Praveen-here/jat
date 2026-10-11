import { randomBytes } from 'node:crypto';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { upsertGoogleUser } from '../auth/users';
import { keyEncryptionKeyFromBase64 } from '../crypto/vault';
import { linkGmailAccount } from '../mail-accounts/accounts';
import { setupTestDb, TEST_DATABASE_URL, type TestDb } from '../testing/test-db';
import { deriveContentKey } from '../crypto/content';
import { matchPending, resetApplications } from './matcher';
import { getApplication, listApplications } from './queries';

const kek = keyEncryptionKeyFromBase64(randomBytes(32).toString('base64'));
const day = (d: number, hour = 9) => new Date(Date.UTC(2026, 7, d, hour));

interface Seed {
  day: number;
  category: string;
  company?: string | null;
  role?: string | null;
  type?: string;
  reqId?: string;
  appRef?: string;
  eventAt?: Date;
  thread?: string;
  senderDomain?: string;
  needsReview?: boolean;
}

describe.skipIf(!TEST_DATABASE_URL)('matching emails into applications (database)', () => {
  let t: TestDb;
  let userId: string;
  let accountId: string;

  beforeAll(async () => {
    t = await setupTestDb();
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    await t.reset();
    userId = (await upsertGoogleUser(t.db, { subject: 'u1', email: 'u1@gmail.com', emailVerified: true, name: 'U' })).id;
    const linked = await linkGmailAccount(t.db, kek, { userId, providerSubject: 'mb', address: 'u1@gmail.com', grantedScopes: [], refreshToken: 'rt' });
    accountId = (linked as { accountId: string }).accountId;
  });

  /** Inserts a classified, extracted email as the sync pipeline would. */
  async function seed(s: Seed): Promise<string> {
    const id = uuidv7();
    const companyKey = s.company ? s.company.toLowerCase().replace(/\s+(labs|technologies|pvt ltd)$/, '') : null;
    await t.db
      .insertInto('source_messages')
      .values({
        id,
        user_id: userId,
        mail_account_id: accountId,
        provider_message_id: `gm-${id}`,
        provider_thread_id: s.thread ?? `thread-${id}`,
        internal_date: day(s.day),
        state: 'awaiting_match',
        sender_domain: s.senderDomain ?? 'greenhouse-mail.io',
        sender_address_hash: `sender-${s.senderDomain ?? 'ats'}`,
        classifier_version: 2,
      })
      .execute();
    await t.db
      .insertInto('message_classifications')
      .values({ id: uuidv7(), source_message_id: id, user_id: userId, version: 2, category: s.category, confidence: 0.9, needs_review: s.needsReview ?? false, rule_hits: [] })
      .execute();
    await t.db
      .insertInto('message_extractions')
      .values({
        id: uuidv7(),
        source_message_id: id,
        user_id: userId,
        version: 1,
        company_display: s.company ?? null,
        company_key: companyKey,
        role_title: s.role ?? null,
        role_key: s.role ? s.role.toLowerCase() : null,
        employment_type: s.type ?? 'unknown',
        req_id: s.reqId ?? null,
        application_ref: s.appRef ?? null,
        event_at: s.eventAt ?? null,
        platform: 'Greenhouse',
      })
      .execute();
    return id;
  }

  async function apps() {
    const rows = await t.db
      .selectFrom('applications')
      .select(['id', 'company_display', 'role_title', 'status', 'origin', 'needs_review', 'status_conflict', 'next_event_at'])
      .where('user_id', '=', userId)
      .orderBy('first_seen_at')
      .orderBy('role_title')
      .execute();
    const events = await t.db.selectFrom('application_events').select(['application_id', 'event_type', 'pending']).execute();
    return rows.map((r) => ({ ...r, events: events.filter((e) => e.application_id === r.id).map((e) => (e.pending ? `${e.event_type}?` : e.event_type)) }));
  }

  it('groups a confirmation and a later rejection (different platforms) into one application', async () => {
    await seed({ day: 1, category: 'APPLICATION_RECEIVED', company: 'Nimbus Labs', role: 'Software Engineer Intern', senderDomain: 'linkedin.com' });
    await seed({ day: 20, category: 'REJECTION', company: 'Nimbus', role: 'Software Engineer Intern' });
    await matchPending(t.db, userId);

    expect(await apps()).toMatchObject([{ company_display: 'Nimbus Labs', status: 'REJECTED', origin: 'auto', events: ['APPLICATION_RECEIVED', 'REJECTION'] }]);
  });

  it('never merges the same role at two different companies', async () => {
    await seed({ day: 1, category: 'APPLICATION_RECEIVED', company: 'Acme', role: 'Data Analyst' });
    await seed({ day: 2, category: 'APPLICATION_RECEIVED', company: 'Zenvault', role: 'Data Analyst' });
    await seed({ day: 9, category: 'REJECTION', company: 'Zenvault', role: 'Data Analyst' });
    await matchPending(t.db, userId);

    const result = await apps();
    expect(result).toHaveLength(2);
    expect(result.find((a) => a.company_display === 'Acme')).toMatchObject({ status: 'APPLIED' });
    expect(result.find((a) => a.company_display === 'Zenvault')).toMatchObject({ status: 'REJECTED' });
  });

  it('keeps two roles at the same company apart', async () => {
    await seed({ day: 1, category: 'APPLICATION_RECEIVED', company: 'Acme', role: 'Data Analyst' });
    await seed({ day: 2, category: 'APPLICATION_RECEIVED', company: 'Acme', role: 'Backend Engineer' });
    await seed({ day: 9, category: 'INTERVIEW_INVITE', company: 'Acme', role: 'Backend Engineer' });
    await seed({ day: 12, category: 'REJECTION', company: 'Acme', role: 'Data Analyst' });
    await matchPending(t.db, userId);

    const result = await apps();
    expect(result).toHaveLength(2);
    expect(result.find((a) => a.role_title === 'Data Analyst')).toMatchObject({ status: 'REJECTED' });
    expect(result.find((a) => a.role_title === 'Backend Engineer')).toMatchObject({ status: 'INTERVIEW' });
  });

  it('attaches a test invite without a role to your only application at that company', async () => {
    await seed({ day: 1, category: 'APPLICATION_RECEIVED', company: 'Acme', role: 'Data Analyst' });
    await seed({ day: 4, category: 'ASSESSMENT_INVITE', company: 'Acme', senderDomain: 'hackerrank.com' });
    await matchPending(t.db, userId);

    expect(await apps()).toMatchObject([{ status: 'ASSESSMENT', needs_review: false, events: ['APPLICATION_RECEIVED', 'ASSESSMENT_INVITE'] }]);
  });

  it("doesn't guess when you have two applications there: the invite waits for your review", async () => {
    await seed({ day: 1, category: 'APPLICATION_RECEIVED', company: 'Acme', role: 'Data Analyst' });
    await seed({ day: 2, category: 'APPLICATION_RECEIVED', company: 'Acme', role: 'Backend Engineer' });
    await seed({ day: 4, category: 'ASSESSMENT_INVITE', company: 'Acme', senderDomain: 'hackerrank.com' });
    await matchPending(t.db, userId);

    const result = await apps();
    expect(result).toHaveLength(2);
    // Neither application moved to ASSESSMENT; the invite is attached as unconfirmed, flagged for review.
    expect(result.every((a) => a.status === 'APPLIED')).toBe(true);
    expect(result.flatMap((a) => a.events)).toContain('ASSESSMENT_INVITE?');
    expect(result.some((a) => a.needs_review)).toBe(true);
  });

  it('treats applying again after a rejection as a new application', async () => {
    await seed({ day: 1, category: 'APPLICATION_RECEIVED', company: 'Acme', role: 'Data Analyst' });
    await seed({ day: 10, category: 'REJECTION', company: 'Acme', role: 'Data Analyst' });
    await seed({ day: 25, category: 'APPLICATION_RECEIVED', company: 'Acme', role: 'Data Analyst' });
    await matchPending(t.db, userId);

    expect((await apps()).map((a) => a.status)).toEqual(['REJECTED', 'APPLIED']);
  });

  it('never merges different requisition ids, even for the same company and role', async () => {
    await seed({ day: 1, category: 'APPLICATION_RECEIVED', company: 'Acme', role: 'Analyst', reqId: 'R-111' });
    await seed({ day: 2, category: 'REJECTION', company: 'Acme', role: 'Analyst', reqId: 'R-222' });
    await matchPending(t.db, userId);

    expect(await apps()).toHaveLength(2);
  });

  it('matches by application id even when the later email names no company', async () => {
    await seed({ day: 1, category: 'APPLICATION_RECEIVED', company: 'Acme', role: 'Analyst', appRef: 'APP-777' });
    await seed({ day: 1, category: 'APPLICATION_RECEIVED', company: 'Other Co', role: 'Designer' });
    await seed({ day: 9, category: 'SHORTLISTED', company: 'Acme', appRef: 'APP-777' });
    await matchPending(t.db, userId);

    expect((await apps()).find((a) => a.company_display === 'Acme')).toMatchObject({ status: 'SHORTLISTED' });
  });

  it('keeps under-merging when two confirmations at one company have no roles', async () => {
    await seed({ day: 1, category: 'APPLICATION_RECEIVED', company: 'Acme' });
    await seed({ day: 3, category: 'APPLICATION_RECEIVED', company: 'Acme' });
    await matchPending(t.db, userId);

    expect(await apps()).toHaveLength(2);
  });

  it('updates the interview time on reschedule, and clears it on cancellation, without new applications', async () => {
    const future = new Date(Date.now() + 10 * 86_400_000);
    const later = new Date(Date.now() + 12 * 86_400_000);
    await seed({ day: 1, category: 'APPLICATION_RECEIVED', company: 'Acme', role: 'Analyst', thread: 'th-1' });
    await seed({ day: 5, category: 'INTERVIEW_INVITE', company: 'Acme', eventAt: future, thread: 'th-1' });
    await seed({ day: 6, category: 'INTERVIEW_RESCHEDULED', company: 'Acme', eventAt: later, thread: 'th-1' });
    await matchPending(t.db, userId);
    expect(await apps()).toMatchObject([{ status: 'INTERVIEW', next_event_at: later }]);

    await seed({ day: 7, category: 'INTERVIEW_CANCELLED', company: 'Acme', thread: 'th-1' });
    await matchPending(t.db, userId);
    expect(await apps()).toMatchObject([{ status: 'INTERVIEW', next_event_at: null }]);
  });

  it('flags an interview invite that arrives after a rejection', async () => {
    await seed({ day: 1, category: 'APPLICATION_RECEIVED', company: 'Acme', role: 'Analyst' });
    await seed({ day: 5, category: 'REJECTION', company: 'Acme', role: 'Analyst' });
    await seed({ day: 9, category: 'INTERVIEW_INVITE', company: 'Acme', role: 'Analyst' });
    await matchPending(t.db, userId);

    expect(await apps()).toMatchObject([{ status: 'INTERVIEW', status_conflict: true, needs_review: true }]);
  });

  it('creates an "inferred" application from a rejection whose confirmation was never seen', async () => {
    await seed({ day: 3, category: 'REJECTION', company: 'Acme', role: 'Analyst' });
    await matchPending(t.db, userId);
    expect(await apps()).toMatchObject([{ status: 'REJECTED', origin: 'inferred' }]);
  });

  it("doesn't create applications from recruiter outreach, and marks it matched", async () => {
    const id = await seed({ day: 3, category: 'RECRUITER_OUTREACH' });
    await matchPending(t.db, userId);
    expect(await apps()).toEqual([]);
    const row = await t.db.selectFrom('source_messages').select('state').where('id', '=', id).executeTakeFirstOrThrow();
    expect(row.state).toBe('matched');
  });

  it('flags applications with no known company for review', async () => {
    await seed({ day: 3, category: 'APPLICATION_RECEIVED', company: null, role: 'Analyst' });
    await matchPending(t.db, userId);
    expect(await apps()).toMatchObject([{ needs_review: true }]);
  });

  it('absorbs the same event reported by two emails on the same day', async () => {
    await seed({ day: 1, category: 'APPLICATION_RECEIVED', company: 'Acme', role: 'Analyst', senderDomain: 'linkedin.com' });
    await seed({ day: 1, category: 'APPLICATION_RECEIVED', company: 'Acme', role: 'Analyst' });
    await matchPending(t.db, userId);

    const [app] = await apps();
    expect(app!.events).toEqual(['APPLICATION_RECEIVED']);
    const links = await t.db.selectFrom('message_application_links').select('application_id').execute();
    expect(links).toHaveLength(2); // both emails still point at the application
  });

  it('rebuilds to the same result, and concurrent matching never duplicates applications', async () => {
    await seed({ day: 1, category: 'APPLICATION_RECEIVED', company: 'Acme', role: 'Analyst' });
    await seed({ day: 4, category: 'INTERVIEW_INVITE', company: 'Acme', role: 'Analyst' });
    await seed({ day: 6, category: 'APPLICATION_RECEIVED', company: 'Zenvault', role: 'Designer' });
    await Promise.all([matchPending(t.db, userId), matchPending(t.db, userId)]);
    const first = (await apps()).map(({ company_display, status, events }) => ({ company_display, status, events }));
    expect(first).toHaveLength(2);

    await resetApplications(t.db, userId);
    await matchPending(t.db, userId);
    expect((await apps()).map(({ company_display, status, events }) => ({ company_display, status, events }))).toEqual(first);
  });
  it("lists and opens only the user's own applications", async () => {
    await seed({ day: 1, category: 'APPLICATION_RECEIVED', company: 'Acme', role: 'Analyst' });
    await seed({ day: 5, category: 'INTERVIEW_INVITE', company: 'Acme', role: 'Analyst' });
    await matchPending(t.db, userId);
    const stranger = (await upsertGoogleUser(t.db, { subject: 'u2', email: 'u2@gmail.com', emailVerified: true, name: null })).id;
    const key = deriveContentKey(kek);

    const mine = await listApplications(t.db, userId, 'all');
    expect(mine.counts).toMatchObject({ all: 1, byStatus: { INTERVIEW: 1 } });
    expect(mine.items[0]).toMatchObject({ company: 'Acme', status: 'INTERVIEW', emailCount: 2 });

    const detail = await getApplication(t.db, key, userId, mine.items[0]!.id);
    expect(detail?.timeline.map((e) => e.type)).toEqual(['APPLICATION_RECEIVED', 'INTERVIEW_INVITE']);

    expect((await listApplications(t.db, stranger, 'all')).items).toEqual([]);
    expect(await getApplication(t.db, key, stranger, mine.items[0]!.id)).toBeNull();
  });
});
