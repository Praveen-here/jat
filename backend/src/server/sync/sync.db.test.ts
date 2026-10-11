import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { upsertGoogleUser } from '../auth/users';
import { contentAad, deriveContentKey, openText } from '../crypto/content';
import { keyEncryptionKeyFromBase64 } from '../crypto/vault';
import { createLogger } from '../lib/logger';
import { linkGmailAccount } from '../mail-accounts/accounts';
import { FakeMailProvider } from '../mail/fake-provider';
import { AuthRevokedError, ProviderUnavailableError } from '../mail/provider';
import { setupTestDb, TEST_DATABASE_URL, type TestDb } from '../testing/test-db';
import { ensureSyncState, syncAccount, type SyncDeps, type SyncOutcome } from './engine';
import { acquireLease, LeaseLostError, renewLease } from './lease';
import { candidateQueries } from './queries';
import { listJobEmails } from '../job-emails/list';
import { createAiClassifier, type AiClassifier } from '../ai/classify-ai';
import { AiRateLimitedError, type LlmClient } from '../ai/groq';
import { ensureMissingSyncStates, findDueAccounts, requestSyncNow } from './schedule';

const kek = keyEncryptionKeyFromBase64(randomBytes(32).toString('base64'));
const DAY = 24 * 3600 * 1000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY);

describe.skipIf(!TEST_DATABASE_URL)('sync engine (database + fake Gmail)', () => {
  let t: TestDb;
  let userId: string;
  const providers = new Map<string, FakeMailProvider>();

  beforeAll(async () => {
    t = await setupTestDb();
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    await t.reset();
    providers.clear();
    userId = (await upsertGoogleUser(t.db, { subject: 'u1', email: 'u1@gmail.com', emailVerified: true, name: 'U' })).id;
  });

  async function connect(fake: FakeMailProvider, subject = 'mailbox-1'): Promise<string> {
    const linked = await linkGmailAccount(t.db, kek, {
      userId,
      providerSubject: subject,
      address: fake.address,
      grantedScopes: [],
      refreshToken: 'rt',
    });
    if (!linked.ok) throw new Error('link failed');
    await ensureSyncState(t.db, linked.accountId);
    providers.set(linked.accountId, fake);
    return linked.accountId;
  }

  function deps(overrides: Partial<SyncDeps> = {}): SyncDeps {
    return {
      db: t.db,
      logger: createLogger({ level: 'silent', service: 'test' }),
      workerId: 'test-worker',
      pepper: 'test-pepper',
      contentKey: deriveContentKey(kek),
      providerFor: (account) => providers.get(account.id)!,
      random: () => 0.5,
      ...overrides,
    };
  }

  async function syncUntilDone(accountId: string, d = deps(), maxRuns = 50): Promise<SyncOutcome[]> {
    const outcomes: SyncOutcome[] = [];
    for (let i = 0; i < maxRuns; i++) {
      const outcome = await syncAccount(d, accountId);
      outcomes.push(outcome);
      if (outcome === 'done') return outcomes;
      if (outcome !== 'more_work' && outcome !== 'failed') return outcomes;
    }
    throw new Error(`sync did not finish: ${outcomes.join(',')}`);
  }

  const ledger = async (accountId: string) =>
    (
      await t.pool.query(
        'select provider_message_id as id, state, rfc822_message_id_hash as hash, internal_date from app.source_messages where mail_account_id = $1 order by provider_message_id',
        [accountId],
      )
    ).rows as Array<{ id: string; state: string; hash: string | null; internal_date: Date | null }>;

  const accountStatus = async (accountId: string) =>
    (await t.pool.query('select status from app.mail_accounts where id = $1', [accountId])).rows[0]?.status as string;

  function seedMailbox(fake: FakeMailProvider) {
    for (let i = 0; i < 10; i++) fake.addMessage({ internalDate: daysAgo(5 + i * 10) }); // candidates in the window
    fake.addMessage({ internalDate: daysAgo(300) }); // candidate, but older than 6 months
    fake.addMessage({ internalDate: daysAgo(400) });
    for (let i = 0; i < 3; i++) fake.addMessage({ internalDate: daysAgo(3 + i), candidate: false }); // not job-related
  }

  it('imports every candidate email in the 6-month window exactly once, across pages and overlapping queries', async () => {
    const fake = new FakeMailProvider({ pageSize: 3 });
    seedMailbox(fake);
    const accountId = await connect(fake);

    expect(await syncUntilDone(accountId)).toEqual(['done']);

    const rows = await ledger(accountId);
    expect(rows).toHaveLength(10);
    expect(rows.every((r) => r.state === 'matched' && r.hash && r.internal_date)).toBe(true);
    expect(await accountStatus(accountId)).toBe('active');
    const { rows: runs } = await t.pool.query('select kind, status, listed from app.sync_runs');
    expect(runs).toEqual([{ kind: 'backfill', status: 'succeeded', listed: 10 }]);
    // 4 query families × 4 pages each (10 results, 3 per page) = 16 list calls.
    expect(fake.calls.listMessages).toBe(Object.keys(candidateQueries(new Date())).length * 4);
  });

  it('resumes where it stopped (work budget and a crash mid-import) without losing or duplicating anything', async () => {
    const fake = new FakeMailProvider({ pageSize: 3 });
    seedMailbox(fake);
    const accountId = await connect(fake);
    // Fail one search page part-way through the first run.
    let listCalls = 0;
    fake.onCall = (method) => {
      if (method === 'listMessages' && ++listCalls === 6) throw new ProviderUnavailableError('http_503');
    };

    const outcomes = await syncUntilDone(accountId, deps({ budget: { maxMessages: 4 } }));

    expect(outcomes).toContain('failed');
    expect(outcomes.at(-1)).toBe('done');
    expect(await ledger(accountId)).toHaveLength(10);
    // Saved cursors mean no page was searched twice: 16 pages + the 1 failed attempt.
    expect(fake.calls.listMessages).toBe(17);
  });

  it('catches email that arrives while the import is running (checkpoint anchored first)', async () => {
    const fake = new FakeMailProvider({ pageSize: 3 });
    seedMailbox(fake);
    const accountId = await connect(fake);
    let added = false;
    fake.onCall = (method) => {
      if (method === 'listMessages' && !added) {
        added = true;
        // Not matched by the search queries: only incremental sync can find it.
        fake.addMessage({ id: 'arrived-mid-import', candidate: false });
      }
    };

    await syncUntilDone(accountId);
    await syncAccount(deps(), accountId); // the next routine sync

    expect((await ledger(accountId)).map((r) => r.id)).toContain('arrived-mid-import');
  });

  it('incremental sync records new mail and ignores spam, trash, drafts and sent mail', async () => {
    const fake = new FakeMailProvider();
    const accountId = await connect(fake);
    await syncUntilDone(accountId);

    fake.addMessage({ id: 'new-1', candidate: false });
    fake.addMessage({ id: 'new-2' });
    fake.addMessage({ id: 'spam', labelIds: ['SPAM'] });
    fake.addMessage({ id: 'sent', labelIds: ['SENT'] });
    fake.addMessage({ id: 'draft', labelIds: ['DRAFT'] });
    fake.addMessage({ id: 'trash', labelIds: ['TRASH'] });
    expect(await syncAccount(deps(), accountId)).toBe('done');

    expect((await ledger(accountId)).map((r) => r.id)).toEqual(['new-1', 'new-2']);
  });

  it('recovers from an expired checkpoint by re-scanning only the gap, without losing job emails', async () => {
    const fake = new FakeMailProvider({ pageSize: 3 });
    seedMailbox(fake);
    const accountId = await connect(fake);
    await syncUntilDone(accountId);

    fake.addMessage({ id: 'during-outage-1' });
    fake.addMessage({ id: 'during-outage-2' });
    fake.expireHistory();

    await syncUntilDone(accountId);

    const ids = (await ledger(accountId)).map((r) => r.id);
    expect(ids).toEqual(expect.arrayContaining(['during-outage-1', 'during-outage-2']));
    expect(ids).toHaveLength(12);
    const { rows: runs } = await t.pool.query(`select status from app.sync_runs where kind = 'gap_recovery'`);
    expect(runs).toEqual([{ status: 'succeeded' }]);
    expect(await accountStatus(accountId)).toBe('active');

    // And incremental sync works again from the new checkpoint.
    fake.addMessage({ id: 'after-recovery' });
    await syncAccount(deps(), accountId);
    expect((await ledger(accountId)).map((r) => r.id)).toContain('after-recovery');
  });

  it('runs only one sync per mailbox at a time', async () => {
    const fake = new FakeMailProvider();
    seedMailbox(fake);
    const accountId = await connect(fake);

    const outcomes = await Promise.all([syncAccount(deps(), accountId), syncAccount(deps({ workerId: 'other' }), accountId)]);

    expect(outcomes.sort()).toEqual(['done', 'locked']);
    expect(await ledger(accountId)).toHaveLength(10);
  });

  it('a worker whose lease expired cannot keep writing (fencing)', async () => {
    const accountId = await connect(new FakeMailProvider());
    const stale = await acquireLease(t.db, accountId, 'slow-worker');
    await t.pool.query(`update app.sync_states set lease_expires_at = now() - interval '1 second'`);
    const fresh = await acquireLease(t.db, accountId, 'new-worker');

    expect(fresh).not.toBeNull();
    await expect(renewLease(t.db, stale!)).rejects.toBeInstanceOf(LeaseLostError);
    await expect(renewLease(t.db, fresh!)).resolves.toBeUndefined();
  });

  it('backs off after a failure (e.g. rate limit) and recovers on the next run', async () => {
    const fake = new FakeMailProvider();
    seedMailbox(fake);
    const accountId = await connect(fake);
    fake.failNext('getMessages', new ProviderUnavailableError('rate_limited'));

    expect(await syncAccount(deps(), accountId)).toBe('failed');
    const { rows: [failed] } = await t.pool.query(
      `select consecutive_failures, last_error_code, next_sync_at > now() as delayed from app.sync_states`,
    );
    expect(failed).toEqual({ consecutive_failures: 1, last_error_code: 'rate_limited', delayed: true });

    expect(await syncUntilDone(accountId)).toContain('done');
    const { rows: [recovered] } = await t.pool.query('select consecutive_failures, last_error_code from app.sync_states');
    expect(recovered).toEqual({ consecutive_failures: 0, last_error_code: null });
    expect(await ledger(accountId)).toHaveLength(10);
  });

  it('stops syncing and asks for reconnection when Google access is revoked', async () => {
    const fake = new FakeMailProvider();
    const accountId = await connect(fake);
    fake.failNext('getProfile', new AuthRevokedError('invalid_grant'));

    expect(await syncAccount(deps(), accountId)).toBe('reauth_required');
    expect(await accountStatus(accountId)).toBe('reauth_required');
    expect(await syncAccount(deps(), accountId)).toBe('skipped');
    await t.pool.query('update app.sync_states set next_sync_at = now()');
    expect(await findDueAccounts(t.db)).not.toContain(accountId);
  });

  it('skips messages deleted before being read, and gives up on a broken message after 5 tries without blocking others', async () => {
    const fake = new FakeMailProvider();
    seedMailbox(fake);
    const accountId = await connect(fake);
    const [first, second] = (await fake.listMessages('after:0')).refs;
    fake.failMessage(first!.id);
    fake.onCall = (method) => {
      if (method === 'getMessages') fake.deleteMessage(second!.id);
    };

    await syncAccount(deps(), accountId);
    for (let i = 0; i < 4; i++) {
      await t.pool.query(`update app.source_messages set next_attempt_at = now() where state = 'retry'`);
      await syncAccount(deps(), accountId);
    }

    const byId = new Map((await ledger(accountId)).map((r) => [r.id, r.state]));
    expect(byId.get(first!.id)).toBe('failed');
    expect(byId.get(second!.id)).toBe('skipped_gone');
    expect([...byId.values()].filter((s) => s === 'matched')).toHaveLength(8);
    expect(await accountStatus(accountId)).toBe('active');
  });

  it('gives the same email in two connected mailboxes the same fingerprint', async () => {
    const personal = new FakeMailProvider({ address: 'personal@gmail.com' });
    const college = new FakeMailProvider({ address: 'college@gmail.com' });
    personal.addMessage({ id: 'p1', internalDate: daysAgo(2), messageIdHeader: '<Offer-123@acme.com>' });
    college.addMessage({ id: 'c9', internalDate: daysAgo(2), messageIdHeader: '<offer-123@ACME.com> ' });
    const a = await connect(personal, 'personal');
    const b = await connect(college, 'college');

    await syncUntilDone(a);
    await syncUntilDone(b);

    const [pa] = await ledger(a);
    const [pb] = await ledger(b);
    expect(pa!.hash).toBeTruthy();
    expect(pa!.hash).toBe(pb!.hash);
    // A keyed hash: not the plain Message-ID.
    expect(pa!.hash).not.toContain('acme');
  });

  describe('scheduling', () => {
    it('heals mailboxes that have no sync state, so none is stranded', async () => {
      const accountId = await connect(new FakeMailProvider());
      await t.pool.query('delete from app.sync_states');
      expect(await findDueAccounts(t.db)).toEqual([]);

      expect(await ensureMissingSyncStates(t.db)).toBe(1);
      expect(await ensureMissingSyncStates(t.db)).toBe(0);
      expect(await findDueAccounts(t.db)).toEqual([accountId]);
    });

    it('finds mailboxes that are due and not being synced', async () => {
      const accountId = await connect(new FakeMailProvider());
      expect(await findDueAccounts(t.db)).toEqual([accountId]);

      await acquireLease(t.db, accountId, 'busy-worker');
      expect(await findDueAccounts(t.db)).toEqual([]);
    });

    it('"Sync now" works for your own mailbox, at most once a minute', async () => {
      const accountId = await connect(new FakeMailProvider());
      await syncUntilDone(accountId);

      expect(await requestSyncNow(t.db, userId, accountId)).toBe('too_soon');
      await t.pool.query(`update app.sync_states set last_attempt_at = now() - interval '2 minutes'`);
      expect(await requestSyncNow(t.db, userId, accountId)).toBe('queued');

      const other = (await upsertGoogleUser(t.db, { subject: 'u2', email: 'u2@gmail.com', emailVerified: true, name: null })).id;
      expect(await requestSyncNow(t.db, other, accountId)).toBe('not_found');
    });
  });

  it('disconnecting a mailbox deletes its whole ledger and sync history', async () => {
    const fake = new FakeMailProvider();
    seedMailbox(fake);
    const accountId = await connect(fake);
    await syncUntilDone(accountId);

    await t.pool.query('delete from app.mail_accounts where id = $1', [accountId]);

    const { rows } = await t.pool.query(`select
      (select count(*) from app.source_messages)::int as messages,
      (select count(*) from app.sync_runs)::int as runs,
      (select count(*) from app.sync_states)::int as states`);
    expect(rows[0]).toEqual({ messages: 0, runs: 0, states: 0 });
  });
  describe('classification during sync (privacy)', () => {
    it("never downloads the body of new personal mail; keeps no content for non-job email", async () => {
      const fake = new FakeMailProvider();
      const accountId = await connect(fake);
      await syncUntilDone(accountId);

      fake.addMessage({ id: 'personal', candidate: false, from: 'Mom <mom@gmail.com>', subject: 'Dinner tonight?', text: 'Are you coming home by 8? My secret recipe inside.' });
      fake.addMessage({ id: 'job', candidate: false });
      await syncAccount(deps(), accountId);

      expect(fake.fullyFetched.has('personal')).toBe(false);
      expect(fake.fullyFetched.has('job')).toBe(true);
      const { rows } = await t.pool.query(
        "select provider_message_id as id, state, subject_enc, sender_enc, snippet_enc, sender_domain from app.source_messages where provider_message_id in ('personal', 'job') order by 1",
      );
      expect(rows[0]).toMatchObject({ id: 'job', state: 'matched', sender_domain: 'greenhouse.io' });
      expect(rows[1]).toEqual({ id: 'personal', state: 'irrelevant', subject_enc: null, sender_enc: null, snippet_enc: null, sender_domain: null });
    });

    it('stores the subject and sender of job emails encrypted, plus category and extracted fields', async () => {
      const fake = new FakeMailProvider();
      fake.addMessage({ id: 'conf', internalDate: daysAgo(3) });
      const accountId = await connect(fake);
      await syncUntilDone(accountId);

      const { rows: [row] } = await t.pool.query("select id, subject_enc, sender_enc from app.source_messages where provider_message_id = 'conf'");
      const raw = Buffer.concat([row.subject_enc, row.sender_enc]).toString('latin1');
      expect(raw).not.toContain('Fake Corp');
      expect(raw).not.toContain('greenhouse');
      const key = deriveContentKey(kek);
      expect(openText(key, row.subject_enc, contentAad(row.id, 'subject'))).toBe('Thank you for applying to Fake Corp');
      // Bound to its row and field: a subject can't be decrypted as another row's (or as the sender).
      expect(() => openText(key, row.subject_enc, contentAad(row.id, 'sender'))).toThrow();

      const { rows: [result] } = await t.pool.query(
        `select c.category, c.needs_review, e.company_display, e.role_title, e.platform
           from app.message_classifications c join app.message_extractions e using (source_message_id)
          where c.source_message_id = $1 and c.is_current and e.is_current`,
        [row.id],
      );
      expect(result).toEqual({ category: 'APPLICATION_RECEIVED', needs_review: false, company_display: 'Fake Corp', role_title: 'Backend Engineer', platform: 'Greenhouse' });
    });

    it('drops job alerts found by the search, keeping no content', async () => {
      const fake = new FakeMailProvider();
      fake.addMessage({
        id: 'alert',
        internalDate: daysAgo(2),
        from: 'LinkedIn <jobalerts-noreply@linkedin.com>',
        subject: '25 new jobs for Backend Engineer',
        text: 'Jobs you may be interested in. Apply now.',
        bulk: true,
      });
      const accountId = await connect(fake);
      await syncUntilDone(accountId);

      const { rows } = await t.pool.query(
        "select s.state, s.subject_enc, c.category from app.source_messages s join app.message_classifications c on c.source_message_id = s.id",
      );
      expect(rows).toEqual([{ state: 'irrelevant', subject_enc: null, category: 'JOB_ALERT' }]);
    });

    it('marks the same job email arriving in a second mailbox as a duplicate of the first', async () => {
      const personal = new FakeMailProvider({ address: 'personal@gmail.com' });
      const college = new FakeMailProvider({ address: 'college@gmail.com' });
      personal.addMessage({ id: 'p1', internalDate: daysAgo(2), messageIdHeader: '<offer-1@acme.com>' });
      college.addMessage({ id: 'c1', internalDate: daysAgo(2), messageIdHeader: '<offer-1@acme.com>' });
      await syncUntilDone(await connect(personal, 'personal'));
      await syncUntilDone(await connect(college, 'college'));

      const { rows } = await t.pool.query(
        'select provider_message_id as id, state, (duplicate_of_id is not null) as linked from app.source_messages order by provider_message_id',
      );
      expect(rows).toEqual([
        { id: 'c1', state: 'duplicate', linked: true },
        { id: 'p1', state: 'matched', linked: false },
      ]);
    });
    it("lists a user's own job emails, decrypted, and never anyone else's", async () => {
      const fake = new FakeMailProvider({ address: 'me@gmail.com' });
      fake.addMessage({ id: 'mine', internalDate: daysAgo(1) });
      await syncUntilDone(await connect(fake));
      const stranger = (await upsertGoogleUser(t.db, { subject: 'u9', email: 'u9@gmail.com', emailVerified: true, name: null })).id;
      const key = deriveContentKey(kek);

      const mine = await listJobEmails(t.db, key, userId, { view: 'all' });
      expect(mine.counts).toEqual({ all: 1, review: 0 });
      expect(mine.items[0]).toMatchObject({
        account: 'me@gmail.com',
        category: 'APPLICATION_RECEIVED',
        company: 'Fake Corp',
        subject: 'Thank you for applying to Fake Corp',
        sender: { address: 'no-reply@greenhouse.io' },
      });
      expect(mine.items[0]!.gmailUrl).toContain('#all/mine');
      expect((await listJobEmails(t.db, key, stranger, { view: 'all' })).items).toEqual([]);
      expect((await listJobEmails(t.db, key, userId, { view: 'review' })).items).toEqual([]);
    });
  });
  describe('with AI', () => {
    const agreeing = JSON.stringify({
      category: 'APPLICATION_RECEIVED', about_own_application: true, company: 'Fake Corp', company_quote: 'applying to Fake Corp',
      role: 'Backend Engineer', role_quote: 'Backend Engineer role', employment_type: 'unknown', event_date_text: null, date_kind: 'none', confidence: 0.95,
    });

    it('sorts everything quickly with rules, and the AI double-check waits out rate limits', async () => {
      const fake = new FakeMailProvider();
      seedMailbox(fake);
      const accountId = await connect(fake);
      let limited = true;
      const ai: AiClassifier = {
        classify: async (email, privacy) => {
          if (limited) throw new AiRateLimitedError(60_000);
          return createAiClassifier({ model: 'fake', completeJson: async () => agreeing }).classify(email, privacy);
        },
      };

      await syncAccount(deps({ ai }), accountId);
      // Phase 1 finished without the AI: every email sorted and grouped already.
      expect((await ledger(accountId)).every((r) => r.state === 'matched')).toBe(true);
      expect((await t.pool.query('select count(*)::int as n from app.applications')).rows[0].n).toBeGreaterThan(0);
      const { rows: queued } = await t.pool.query("select ai_state, (ai_retry_at > now()) as waiting, attempts from app.source_messages where ai_state = 'pending'");
      expect(queued.length).toBe(10);
      expect(queued.some((r) => r.waiting)).toBe(true);

      limited = false;
      await t.pool.query('update app.source_messages set ai_retry_at = now()');
      await syncUntilDone(accountId, deps({ ai }));
      const { rows: after } = await t.pool.query('select ai_state, count(*)::int as n from app.source_messages group by ai_state');
      expect(after).toEqual([{ ai_state: 'done', n: 10 }]);
      expect((await ledger(accountId)).every((r) => r.state === 'matched')).toBe(true);
    });

    it('with slow AI, saves progress in small steps and resumes without losing or failing emails', async () => {
      const fake = new FakeMailProvider();
      seedMailbox(fake);
      const accountId = await connect(fake);
      const slowAi: AiClassifier = {
        classify: async (email, privacy) => {
          await new Promise((resolve) => setTimeout(resolve, 30));
          return createAiClassifier({ model: 'fake', completeJson: async () => agreeing }).classify(email, privacy);
        },
      };
      // A tiny time budget stands in for "AI calls take minutes".
      const outcome = await syncAccount(deps({ ai: slowAi, budget: { maxMillis: 1 } }), accountId);
      expect(outcome).toBe('more_work');
      const { rows: afterFirst } = await t.pool.query('select state, count(*)::int as n from app.source_messages group by state order by state');
      // Progress was saved, and nothing unprocessed was marked failed or waiting.
      expect(afterFirst.find((r) => r.state === 'awaiting_match' || r.state === 'matched')).toBeTruthy();
      expect(afterFirst.find((r) => r.state === 'retry' || r.state === 'failed')).toBeUndefined();

      const outcomes = await syncUntilDone(accountId, deps({ ai: slowAi, budget: { maxMillis: 1 } }));
      expect(outcomes.at(-1)).toBe('done');
      expect((await ledger(accountId)).every((r) => r.state === 'matched')).toBe(true);
    });

    it("never puts the user's own addresses into what is sent to the AI", async () => {
      const prompts: string[] = [];
      const client: LlmClient = { model: 'fake', completeJson: async (req) => (prompts.push(req.user), agreeing) };
      const fake = new FakeMailProvider({ address: 'student@gmail.com' });
      fake.addMessage({
        internalDate: daysAgo(2),
        text: 'Hi, thank you for applying to Fake Corp for the Backend Engineer role. We emailed student@gmail.com and u1@gmail.com a copy.',
      });
      const accountId = await connect(fake);
      await syncUntilDone(accountId, deps({ ai: createAiClassifier(client) }));

      expect(prompts.length).toBe(1);
      expect(prompts[0]).not.toContain('student@gmail.com');
      expect(prompts[0]).not.toContain('u1@gmail.com');
      expect(prompts[0]).toContain('Fake Corp');
    });
  });
});
