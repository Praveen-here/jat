import { sql, type Kysely, type Transaction } from 'kysely';
import { v7 as uuidv7 } from 'uuid';
import { LIFECYCLE_CATEGORIES, type Category } from '../classify/categories';
import { findRegistryEntry } from '../classify/registry';
import type { Database } from '../db/pool';
import { project, TERMINAL, type AppStatus } from './status';

/**
 * Groups job emails into applications (docs/plan/03-matching-and-lifecycle.md §8).
 *
 * Deterministic scoring with hard vetoes. Principles:
 *  1. Under-merging beats over-merging: a missed link is one click to fix; a wrong merge silently
 *     corrupts history. When unsure, attach as "pending" and ask, or start a new application.
 *  2. Identifiers decide first (application/requisition/posting ids), then thread, then
 *     company + role. A company match alone never decides when you have several applications there.
 *  3. Emails are matched in date order, per user, under a lock.
 */
export const MATCHER_VERSION = 1;

const CONFIDENT = 5;
const PROBABLE = 3;
const MARGIN = 2;
const DAY_MS = 86_400_000;

type IdKind = 'req_id' | 'application_ref' | 'job_posting_id';

interface MessageFacts {
  messageId: string;
  accountId: string;
  threadId: string | null;
  receivedAt: Date;
  category: Category;
  needsReview: boolean;
  companyKey: string | null;
  companyDisplay: string | null;
  roleKey: string | null;
  roleTitle: string | null;
  employmentType: string;
  platform: string | null;
  eventAt: Date | null;
  deadlineAt: Date | null;
  ids: Array<{ kind: IdKind; value: string }>;
  /** For shortlists: 'assessment' | 'interview'. */
  nextStep: string | null;
  /** Only for senders that are people/companies, not shared platform no-reply addresses. */
  senderKey: string | null;
}

interface AppState {
  id: string;
  companyKey: string | null;
  roleKey: string | null;
  employmentType: string;
  status: AppStatus;
  terminalAt: Date | null;
  lastActivityAt: Date;
  hasApplied: boolean;
  ids: Map<IdKind, Set<string>>;
  threads: Set<string>;
  senders: Set<string>;
}

export interface Candidate {
  app: AppState;
  score: number;
  features: Record<string, number>;
}

// ---- similarity helpers ----------------------------------------------------------------------------

const squash = (s: string) => s.replace(/[^a-z0-9]/g, '');

/** "nimbus" vs "nimbus labs", "tatvafintech" vs "tatva fintech": the same company. */
export function companiesCompatible(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  const x = squash(a);
  const y = squash(b);
  return x === y || (Math.min(x.length, y.length) >= 4 && (x.startsWith(y) || y.startsWith(x)));
}

const ROLE_STOPWORDS = new Set(['and', 'of', 'the', 'a', 'an', 'for', 'in', 'at', 'with', '-']);

/** Token overlap (Jaccard) of two role keys, 0..1. */
export function roleSimilarity(a: string, b: string): number {
  const ta = new Set(a.split(' ').filter((t) => t && !ROLE_STOPWORDS.has(t)));
  const tb = new Set(b.split(' ').filter((t) => t && !ROLE_STOPWORDS.has(t)));
  if (!ta.size || !tb.size) return 0;
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared++;
  return shared / (ta.size + tb.size - shared);
}

const isSpecificRole = (key: string) => key.split(' ').filter((t) => !ROLE_STOPWORDS.has(t)).length >= 2;

// ---- scoring ---------------------------------------------------------------------------------------

/** Why a candidate can't be the same application, or null. */
function veto(app: AppState, m: MessageFacts): string | null {
  if (app.companyKey && m.companyKey && !companiesCompatible(app.companyKey, m.companyKey)) return 'different_company';
  for (const { kind, value } of m.ids) {
    const known = app.ids.get(kind);
    if (known?.size && !known.has(value)) return `different_${kind}`;
  }
  if (app.roleKey && m.roleKey && roleSimilarity(app.roleKey, m.roleKey) < 0.3 && isSpecificRole(app.roleKey) && isSpecificRole(m.roleKey)) {
    return 'different_role';
  }
  if (app.employmentType !== 'unknown' && m.employmentType !== 'unknown' && app.employmentType !== m.employmentType) return 'different_type';
  if (m.category === 'APPLICATION_RECEIVED') {
    // Applying again after a rejection is a new application.
    if (TERMINAL.has(app.status) && app.terminalAt && app.terminalAt <= m.receivedAt) return 'reapplication';
    // A second confirmation is a different application unless the roles clearly agree
    // (e.g. LinkedIn and the company's ATS both confirming the same job).
    if (app.hasApplied && !(app.roleKey && m.roleKey && roleSimilarity(app.roleKey, m.roleKey) >= 0.8)) return 'second_confirmation';
  }
  return null;
}

export function scoreCandidate(app: AppState, m: MessageFacts, openAtCompany: number, openWithRole = 0): Candidate | null {
  if (veto(app, m)) return null;
  const f: Record<string, number> = {};
  if (m.threadId && app.threads.has(`${m.accountId}:${m.threadId}`)) f.same_thread = 3;
  const sameCompany = companiesCompatible(app.companyKey, m.companyKey);
  if (sameCompany) f.same_company = 2;
  if (app.roleKey && m.roleKey) {
    const sim = roleSimilarity(app.roleKey, m.roleKey);
    if (sim >= 0.8) f.same_role = 3;
    else if (sim >= 0.5) f.similar_role = 1.5;
  }
  if (sameCompany && openAtCompany === 1) f.only_open_application_there = 2.5;
  // The email names a specific role that matches exactly one open application (e.g. a test
  // invite from an assessment platform that doesn't clearly name the employer).
  if (openWithRole === 1 && m.roleKey && app.roleKey && roleSimilarity(app.roleKey, m.roleKey) >= 0.8 && isSpecificRole(m.roleKey)) f.only_open_application_with_role = 2;
  if (m.senderKey && app.senders.has(m.senderKey)) f.same_sender = 1.5;
  if (m.category !== 'APPLICATION_RECEIVED' && app.lastActivityAt <= m.receivedAt) f.plausible_sequence = 1;
  if (m.receivedAt.getTime() - app.lastActivityAt.getTime() > 180 * DAY_MS) f.long_gap = -2;
  if (!m.roleKey && !m.ids.length && openAtCompany > 1) f.ambiguous_company = -(openAtCompany - 1);
  const score = Object.values(f).reduce((a, b) => a + b, 0);
  return { app, score, features: f };
}

export type Decision =
  | { kind: 'identifier'; app: AppState }
  | { kind: 'confident' | 'probable' | 'ambiguous'; app: AppState; score: number }
  | { kind: 'new' };

export function decide(m: MessageFacts, apps: AppState[]): Decision {
  // 1. A shared strong identifier decides.
  for (const app of apps) {
    if (m.ids.some(({ kind, value }) => app.ids.get(kind)?.has(value))) return { kind: 'identifier', app };
  }
  // 2. Otherwise score plausible candidates.
  const openAtCompany = m.companyKey
    ? apps.filter(
        (a) => companiesCompatible(a.companyKey, m.companyKey) && !TERMINAL.has(a.status) && m.receivedAt.getTime() - a.lastActivityAt.getTime() <= 180 * DAY_MS,
      ).length
    : 0;
  const openWithRole = m.roleKey
    ? apps.filter((a) => a.roleKey && !TERMINAL.has(a.status) && roleSimilarity(a.roleKey, m.roleKey!) >= 0.8).length
    : 0;
  const scored = apps
    .map((app) => scoreCandidate(app, m, openAtCompany, openWithRole))
    .filter((c): c is Candidate => !!c && c.score > 0)
    .sort((a, b) => b.score - a.score);
  const [best, second] = scored;
  // Several open applications at this company and nothing in the email to tell them apart:
  // don't invent another application; attach to the best guess as unconfirmed and ask.
  const sameCompany = scored.filter((c) => c.features.same_company);
  if (best && best.score < PROBABLE && sameCompany.length >= 2 && !m.roleKey && !m.ids.length && m.category !== 'APPLICATION_RECEIVED') {
    return { kind: 'ambiguous', app: sameCompany[0]!.app, score: sameCompany[0]!.score };
  }
  if (!best || best.score < PROBABLE) return { kind: 'new' };
  const close = scored.filter((c) => c.score >= PROBABLE && best.score - c.score < MARGIN).length;
  if (best.score >= CONFIDENT && best.score - (second?.score ?? 0) >= MARGIN) return { kind: 'confident', app: best.app, score: best.score };
  if (close >= 2) return { kind: 'ambiguous', app: best.app, score: best.score };
  return { kind: 'probable', app: best.app, score: best.score };
}

// ---- database ----------------------------------------------------------------------------------------

/** Events like "applied" or "rejected" happen once per day per application; others once per email. */
function dedupeKey(m: MessageFacts): string {
  const once = ['APPLICATION_RECEIVED', 'REJECTION', 'OFFER', 'WITHDRAWAL_CONFIRMATION'];
  return once.includes(m.category) ? `${m.category}:${m.receivedAt.toISOString().slice(0, 10)}` : `msg:${m.messageId}`;
}

async function loadPending(trx: Transaction<Database>, userId: string): Promise<MessageFacts[]> {
  const rows = await trx
    .selectFrom('source_messages as s')
    .innerJoin('message_classifications as c', (j) => j.onRef('c.source_message_id', '=', 's.id').on('c.is_current', '=', true))
    .leftJoin('message_extractions as e', (j) => j.onRef('e.source_message_id', '=', 's.id').on('e.is_current', '=', true))
    .select([
      's.id', 's.mail_account_id', 's.provider_thread_id', 's.internal_date', 's.sender_domain', 's.sender_address_hash',
      'c.category', 'c.needs_review',
      'e.company_key', 'e.company_display', 'e.role_key', 'e.role_title', 'e.employment_type', 'e.platform', 'e.event_at',
      'e.deadline_at', 'e.req_id', 'e.application_ref', 'e.job_posting_id', 'e.next_step',
    ])
    .where('s.user_id', '=', userId)
    .where('s.state', '=', 'awaiting_match')
    .orderBy('s.internal_date', 'asc')
    .orderBy('s.id')
    .execute();
  return rows.map((r) => {
    const ids: MessageFacts['ids'] = [];
    // Requisition ids are only unique within a company.
    if (r.req_id) ids.push({ kind: 'req_id', value: `${r.company_key ?? '?'}:${r.req_id.toLowerCase()}` });
    if (r.application_ref) ids.push({ kind: 'application_ref', value: `${r.company_key ?? '?'}:${r.application_ref.toLowerCase()}` });
    if (r.job_posting_id) ids.push({ kind: 'job_posting_id', value: r.job_posting_id.toLowerCase() });
    const platformSender = !!findRegistryEntry(r.sender_domain);
    return {
      messageId: r.id,
      accountId: r.mail_account_id,
      threadId: r.provider_thread_id,
      receivedAt: r.internal_date ?? new Date(0),
      category: r.category as Category,
      needsReview: r.needs_review,
      companyKey: r.company_key,
      companyDisplay: r.company_display,
      roleKey: r.role_key,
      roleTitle: r.role_title,
      employmentType: r.employment_type ?? 'unknown',
      platform: r.platform,
      eventAt: r.event_at,
      deadlineAt: r.deadline_at,
      nextStep: r.next_step,
      ids,
      senderKey: platformSender ? null : r.sender_address_hash,
    };
  });
}

async function loadApps(trx: Transaction<Database>, userId: string): Promise<AppState[]> {
  const [apps, ids, links, applied] = await Promise.all([
    trx.selectFrom('applications').selectAll().where('user_id', '=', userId).execute(),
    trx.selectFrom('application_identifiers').selectAll().where('user_id', '=', userId).execute(),
    trx
      .selectFrom('message_application_links as l')
      .innerJoin('source_messages as s', 's.id', 'l.source_message_id')
      .select(['l.application_id', 's.mail_account_id', 's.provider_thread_id', 's.sender_domain', 's.sender_address_hash'])
      .where('l.user_id', '=', userId)
      .execute(),
    trx
      .selectFrom('application_events')
      .select('application_id')
      .distinct()
      .where('user_id', '=', userId)
      .where('event_type', '=', 'APPLICATION_RECEIVED')
      .execute(),
  ]);
  const byId = new Map<string, AppState>();
  for (const a of apps) {
    byId.set(a.id, {
      id: a.id,
      companyKey: a.company_key,
      roleKey: a.role_key,
      employmentType: a.employment_type,
      status: a.status as AppStatus,
      terminalAt: TERMINAL.has(a.status as AppStatus) ? a.last_activity_at : null,
      lastActivityAt: a.last_activity_at,
      hasApplied: false,
      ids: new Map(),
      threads: new Set(),
      senders: new Set(),
    });
  }
  for (const i of ids) addId(byId.get(i.application_id), i.kind, i.value);
  for (const l of links) {
    const app = byId.get(l.application_id);
    if (!app) continue;
    if (l.provider_thread_id) app.threads.add(`${l.mail_account_id}:${l.provider_thread_id}`);
    if (l.sender_address_hash && !findRegistryEntry(l.sender_domain)) app.senders.add(l.sender_address_hash);
  }
  for (const a of applied) {
    const app = byId.get(a.application_id);
    if (app) app.hasApplied = true;
  }
  return [...byId.values()];
}

function addId(app: AppState | undefined, kind: IdKind, value: string) {
  if (!app) return;
  if (!app.ids.has(kind)) app.ids.set(kind, new Set());
  app.ids.get(kind)!.add(value);
}

async function createApplication(trx: Transaction<Database>, userId: string, m: MessageFacts): Promise<AppState> {
  const id = uuidv7();
  await trx
    .insertInto('applications')
    .values({
      id,
      user_id: userId,
      company_display: m.companyDisplay,
      company_key: m.companyKey,
      role_title: m.roleTitle,
      role_key: m.roleKey,
      employment_type: m.employmentType,
      platform: m.platform,
      origin: m.category === 'APPLICATION_RECEIVED' ? 'auto' : 'inferred',
      status: 'DETECTED',
      first_seen_at: m.receivedAt,
      last_activity_at: m.receivedAt,
    })
    .execute();
  return {
    id,
    companyKey: m.companyKey,
    roleKey: m.roleKey,
    employmentType: m.employmentType,
    status: 'DETECTED',
    terminalAt: null,
    lastActivityAt: m.receivedAt,
    hasApplied: false,
    ids: new Map(),
    threads: new Set(),
    senders: new Set(),
  };
}

/** Recomputes an application's status and summary fields from its events. */
export async function refreshApplication(trx: Transaction<Database> | Kysely<Database>, applicationId: string): Promise<void> {
  const [events, reviewLinks, app] = await Promise.all([
    trx
      .selectFrom('application_events')
      .select(['id', 'event_type', 'occurred_at', 'scheduled_at', 'deadline_at', 'pending', 'detail'])
      .where('application_id', '=', applicationId)
      .execute(),
    trx
      .selectFrom('message_application_links')
      .select('source_message_id')
      .where('application_id', '=', applicationId)
      .where('needs_review', '=', true)
      .limit(1)
      .execute(),
    trx.selectFrom('applications').select('company_display').where('id', '=', applicationId).executeTakeFirstOrThrow(),
  ]);
  const p = project(
    events.map((e) => ({ id: e.id, eventType: e.event_type, occurredAt: e.occurred_at, scheduledAt: e.scheduled_at, deadlineAt: e.deadline_at, pending: e.pending, detail: e.detail })),
  );
  await trx
    .updateTable('applications')
    .set({
      status: p.status,
      status_detail: p.statusDetail,
      status_event_id: p.statusEventId,
      status_conflict: p.conflict,
      applied_at: p.appliedAt,
      first_seen_at: p.firstSeenAt,
      last_activity_at: p.lastActivityAt,
      next_event_at: p.nextEventAt,
      needs_review: reviewLinks.length > 0 || p.conflict || !app.company_display,
      updated_at: sql`now()`,
    })
    .where('id', '=', applicationId)
    .execute();
}

async function attach(
  trx: Transaction<Database>,
  userId: string,
  m: MessageFacts,
  app: AppState,
  decision: Exclude<Decision['kind'], never>,
  score: number,
): Promise<void> {
  const pending = decision === 'probable' || decision === 'ambiguous';
  const needsReview = pending || m.needsReview;

  await trx
    .insertInto('message_application_links')
    .values({ source_message_id: m.messageId, application_id: app.id, user_id: userId, decision, score, needs_review: needsReview })
    .execute();
  await trx
    .insertInto('application_events')
    .values({
      id: uuidv7(),
      application_id: app.id,
      user_id: userId,
      source_message_id: m.messageId,
      event_type: m.category,
      occurred_at: m.receivedAt,
      scheduled_at: m.eventAt,
      deadline_at: m.deadlineAt,
      detail: m.nextStep,
      pending,
      dedupe_key: dedupeKey(m),
    })
    .onConflict((oc) => oc.columns(['application_id', 'dedupe_key']).doNothing())
    .execute();

  if (!pending) {
    for (const { kind, value } of m.ids) {
      await trx.insertInto('application_identifiers').values({ user_id: userId, kind, value, application_id: app.id }).onConflict((oc) => oc.doNothing()).execute();
      addId(app, kind, value);
    }
    // Fill in what the application didn't know yet. Values come from emails (untrusted), so they
    // are always bound as query parameters, never inlined into SQL.
    await trx
      .updateTable('applications')
      .set({
        company_display: sql<string | null>`coalesce(company_display, ${m.companyDisplay}::text)`,
        company_key: sql<string | null>`coalesce(company_key, ${m.companyKey}::text)`,
        role_title: sql<string | null>`coalesce(role_title, ${m.roleTitle}::text)`,
        role_key: sql<string | null>`coalesce(role_key, ${m.roleKey}::text)`,
        platform: sql<string | null>`coalesce(platform, ${m.platform}::text)`,
        employment_type: sql<string>`case when employment_type = 'unknown' then ${m.employmentType}::text else employment_type end`,
      })
      .where('id', '=', app.id)
      .execute();
    app.companyKey ??= m.companyKey;
    app.roleKey ??= m.roleKey;
    if (app.employmentType === 'unknown') app.employmentType = m.employmentType;
    if (m.threadId) app.threads.add(`${m.accountId}:${m.threadId}`);
    if (m.senderKey) app.senders.add(m.senderKey);
    if (m.category === 'APPLICATION_RECEIVED') app.hasApplied = true;
  }

  await refreshApplication(trx, app.id);
  const updated = await trx.selectFrom('applications').select(['status', 'last_activity_at']).where('id', '=', app.id).executeTakeFirstOrThrow();
  app.status = updated.status as AppStatus;
  app.lastActivityAt = updated.last_activity_at;
  app.terminalAt = TERMINAL.has(app.status) ? updated.last_activity_at : null;
}

/**
 * Matches all of a user's classified-but-unmatched emails, oldest first.
 * Serialised per user: two mailboxes syncing at once can't create duplicate applications.
 */
export async function matchPending(db: Kysely<Database>, userId: string): Promise<number> {
  return db.transaction().execute(async (trx) => {
    await sql`select pg_advisory_xact_lock(hashtext(${`match:${userId}`}))`.execute(trx);
    const pending = await loadPending(trx, userId);
    if (pending.length === 0) return 0;
    const apps = await loadApps(trx, userId);

    for (const m of pending) {
      if (LIFECYCLE_CATEGORIES.has(m.category)) {
        const decision = decide(m, apps);
        if (decision.kind === 'new') {
          const app = await createApplication(trx, userId, m);
          apps.push(app);
          await attach(trx, userId, m, app, 'new', 0);
        } else {
          await attach(trx, userId, m, decision.app, decision.kind, decision.kind === 'identifier' ? 10 : decision.score);
        }
      }
      // Recruiter outreach and the like stay visible as emails but don't become applications.
      await trx.updateTable('source_messages').set({ state: 'matched' }).where('id', '=', m.messageId).execute();
    }
    return pending.length;
  });
}

/**
 * Rebuilds from scratch: deletes a user's automatically-built applications and re-queues their
 * emails for matching. Used when the classifier changes (there are no manual edits to keep yet).
 */
export async function resetApplications(db: Kysely<Database>, userId: string): Promise<void> {
  await db.transaction().execute(async (trx) => {
    await sql`select pg_advisory_xact_lock(hashtext(${`match:${userId}`}))`.execute(trx);
    await trx.deleteFrom('applications').where('user_id', '=', userId).execute();
    await trx.updateTable('source_messages').set({ state: 'awaiting_match' }).where('user_id', '=', userId).where('state', '=', 'matched').execute();
  });
}
