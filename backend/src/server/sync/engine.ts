import { sql, type Kysely } from 'kysely';
import { v7 as uuidv7 } from 'uuid';
import type { Database, MailAccountStatus } from '../db/pool';
import { GmailApiError } from '../gmail/client';
import type { Logger } from '../lib/logger';
import {
  AuthRevokedError,
  CheckpointExpiredError,
  ProviderUnavailableError,
  type FetchResult,
  type MailProvider,
  type MessageRef,
} from '../mail/provider';
import { AiBadResponseError, AiRateLimitedError, AiUnavailableError } from '../ai/groq';
import type { AiClassifier, PrivacyContext } from '../ai/classify-ai';
import { matchPending, resetApplications } from '../applications/matcher';
import type { Analysis } from '../classify/analyze';
import { analyzeHybrid, needsAiCheck, rulesFallback } from '../classify/hybrid';
import { CLASSIFIER_VERSION } from '../classify/classifier';
import { acquireLease, LeaseLostError, releaseLease, renewLease, type Lease } from './lease';
import { candidateQueries, QUERY_VERSION } from './queries';
import { fetchForAnalysis, recordFetched, type Fetched, type RecordDeps } from './record';

/**
 * The sync engine (docs/plan/01-oauth-and-sync.md Â§6). One call to syncAccount() does one bounded
 * slice of work for one mailbox, under a lease:
 *
 *   1. first run only: anchor the checkpoint (Gmail historyId) BEFORE scanning, so mail that
 *      arrives during a long import is caught by step 2;
 *   2. incremental: fetch changes since the checkpoint; an expired checkpoint starts a recovery
 *      scan of just the gap;
 *   3. enumeration: page through the candidate search queries, saving the cursor per page;
 *   4. processing: fetch discovered messages in batches and record them in the ledger;
 *   5. schedule the next run (immediately if work remains).
 *
 * Every step is idempotent: re-running after a crash at any point loses nothing and duplicates
 * nothing, because the ledger has a unique key and the checkpoint moves forward only together with
 * the ledger rows it covers (same transaction).
 */

export const BACKFILL_MONTHS = 6;
const FETCH_BATCH = 50;
/**
 * With AI on, each email can take ~15 s (free-tier pacing), so batches are small: results are
 * saved every few emails, progress moves steadily, and a batch never outlives its lease.
 */
const AI_BATCH = 5;
const MAX_MESSAGE_ATTEMPTS = 5;
const GAP_OVERLAP_MS = 2 * 24 * 3600 * 1000;
const MINUTE_MS = 60_000;
const ERROR_AFTER_MS = 24 * 3600 * 1000;

export interface SyncBudget {
  maxMessages: number;
  maxMillis: number;
}

const DEFAULT_BUDGET: SyncBudget = { maxMessages: 2_000, maxMillis: 4 * MINUTE_MS };

export interface SyncDeps {
  db: Kysely<Database>;
  logger: Logger;
  workerId: string;
  /** Secret for Message-ID fingerprints (HMAC_PEPPER). */
  pepper: string;
  /** Key for the encrypted subject/sender/snippet of job emails (crypto/content.ts). */
  contentKey: Buffer;
  /** AI classifier (Groq), or null for rules only. */
  ai?: AiClassifier | null;
  providerFor: (account: { id: string; userId: string }) => MailProvider | Promise<MailProvider>;
  budget?: Partial<SyncBudget>;
  random?: () => number;
}

export type SyncOutcome = 'done' | 'more_work' | 'locked' | 'skipped' | 'reauth_required' | 'failed';

/** Statuses in which an account is synced. */
export const SYNCABLE_STATUSES: MailAccountStatus[] = ['connected', 'backfilling', 'active', 'recovering', 'error'];

interface Ctx {
  deps: SyncDeps;
  db: Kysely<Database>;
  lease: Lease;
  accountId: string;
  userId: string;
  provider: MailProvider;
  budget: SyncBudget;
  startedAt: number;
  processed: number;
}

/** Called when a mailbox is (re)connected: creates its sync state, or asks for a sync soon. */
export async function ensureSyncState(db: Kysely<Database>, accountId: string, now = new Date()): Promise<void> {
  const windowStart = new Date(now);
  windowStart.setMonth(windowStart.getMonth() - BACKFILL_MONTHS);
  // "Due now" uses the DATABASE clock, the same clock findDueAccounts compares against. (The app
  // and database clocks can differ by a little, e.g. Docker on Windows, which made it "not yet due".)
  await db
    .insertInto('sync_states')
    .values({ mail_account_id: accountId, backfill_window_start: windowStart, next_sync_at: sql<Date>`now()` })
    .onConflict((oc) => oc.column('mail_account_id').doUpdateSet({ next_sync_at: sql<Date>`now()` }))
    .execute();
}

export async function syncAccount(deps: SyncDeps, accountId: string): Promise<SyncOutcome> {
  const { db, logger } = deps;
  const account = await db
    .selectFrom('mail_accounts')
    .select(['id', 'user_id', 'status'])
    .where('id', '=', accountId)
    .executeTakeFirst();
  if (!account || !SYNCABLE_STATUSES.includes(account.status)) return 'skipped';

  const lease = await acquireLease(db, accountId, deps.workerId);
  if (!lease) return 'locked';

  const ctx: Ctx = {
    deps,
    db,
    lease,
    accountId,
    userId: account.user_id,
    provider: undefined as unknown as MailProvider,
    budget: { ...DEFAULT_BUDGET, ...deps.budget },
    startedAt: Date.now(),
    processed: 0,
  };

  try {
    await db.updateTable('sync_states').set({ last_attempt_at: sql`now()` }).where('mail_account_id', '=', accountId).execute();
    ctx.provider = await deps.providerFor({ id: accountId, userId: account.user_id });

    await requeueOutdated(ctx);
    if ((await loadState(ctx)).backfill_state === 'pending') await startBackfill(ctx);

    const { checkpoint } = await loadState(ctx);
    if (checkpoint) {
      try {
        await runIncremental(ctx, checkpoint);
      } catch (err) {
        if (!(err instanceof CheckpointExpiredError)) throw err;
        logger.warn({ accountId }, 'sync checkpoint expired; starting recovery scan');
        await startGapRecovery(ctx);
      }
    }

    const enumerationDone = await runEnumeration(ctx);
    await processPending(ctx);
    // Group into applications once this mailbox's emails are all sorted (date order matters).
    if (!(await hasDueWork(ctx))) await matchPending(db, account.user_id);

    // Phase 2: AI double-check in the background; rebuild applications from the improved results.
    if (enumerationDone && !(await hasDueWork(ctx)) && (await refineWithAi(ctx))) {
      await resetApplications(db, account.user_id);
      await matchPending(db, account.user_id);
    }

    const moreWork = !enumerationDone || (await hasDueWork(ctx)) || (await hasDueAiWork(ctx));
    if (!moreWork) await completeRuns(ctx);
    await recordSuccess(ctx, moreWork);
    logger.info({ accountId, count: ctx.processed, status: moreWork ? 'more_work' : 'done' }, 'sync run finished');
    return moreWork ? 'more_work' : 'done';
  } catch (err) {
    if (err instanceof LeaseLostError) {
      logger.warn({ accountId }, 'sync lease lost; stopping');
      return 'locked';
    }
    if (err instanceof AuthRevokedError) {
      await markReauthRequired(ctx, err.code);
      logger.warn({ accountId, errorCode: err.code }, 'mailbox access revoked; reconnect required');
      return 'reauth_required';
    }
    const code = errorCode(err);
    logger.error({ err, accountId, errorCode: code }, 'sync run failed');
    await recordFailure(ctx, code);
    return 'failed';
  } finally {
    await releaseLease(db, lease).catch(() => undefined);
  }
}

// ---- steps ---------------------------------------------------------------------------------------

function loadState(ctx: Ctx) {
  return ctx.db.selectFrom('sync_states').selectAll().where('mail_account_id', '=', ctx.accountId).executeTakeFirstOrThrow();
}

function budgetExhausted(ctx: Ctx): boolean {
  return ctx.processed >= ctx.budget.maxMessages || Date.now() - ctx.startedAt >= ctx.budget.maxMillis;
}

async function startBackfill(ctx: Ctx): Promise<void> {
  const profile = await ctx.provider.getProfile();
  const state = await loadState(ctx);
  const runId = uuidv7();
  await ctx.db.transaction().execute(async (trx) => {
    await renewLease(trx, ctx.lease);
    await trx
      .updateTable('sync_states')
      .set({
        checkpoint: profile.checkpoint,
        checkpoint_updated_at: sql`now()`,
        backfill_state: 'enumerating',
        backfill_run_id: runId,
      })
      .where('mail_account_id', '=', ctx.accountId)
      .execute();
    await trx
      .insertInto('sync_runs')
      .values({
        id: runId,
        mail_account_id: ctx.accountId,
        kind: 'backfill',
        query_version: QUERY_VERSION,
        window_start: state.backfill_window_start,
      })
      .execute();
    await setAccountStatus(trx, ctx.accountId, 'backfilling');
  });
}

async function runIncremental(ctx: Ctx, checkpoint: string): Promise<void> {
  const refs: MessageRef[] = [];
  let pageToken: string | undefined;
  let newCheckpoint = checkpoint;
  do {
    const page = await ctx.provider.listChanges(checkpoint, pageToken);
    refs.push(...page.added);
    pageToken = page.nextPageToken;
    newCheckpoint = page.checkpoint;
  } while (pageToken);

  // Ledger rows and the new checkpoint commit together: crash before â†’ the same changes are
  // re-read next time; crash after â†’ they're safely in the ledger.
  await ctx.db.transaction().execute(async (trx) => {
    await renewLease(trx, ctx.lease);
    await insertRefs(trx, ctx, refs, null);
    await trx
      .updateTable('sync_states')
      .set({ checkpoint: newCheckpoint, checkpoint_updated_at: sql`now()` })
      .where('mail_account_id', '=', ctx.accountId)
      // Gmail historyIds are numbers: only ever move forward.
      .where(sql<boolean>`checkpoint is null or checkpoint::numeric < ${newCheckpoint}::numeric`)
      .execute();
  });
}

async function startGapRecovery(ctx: Ctx): Promise<void> {
  const profile = await ctx.provider.getProfile();
  const state = await loadState(ctx);
  const lastGood = state.last_success_at ?? state.backfill_window_start;
  const since = new Date(Math.max(state.backfill_window_start.getTime(), lastGood.getTime() - GAP_OVERLAP_MS));

  await ctx.db.transaction().execute(async (trx) => {
    await renewLease(trx, ctx.lease);
    // Anchor first, like a backfill: anything newer than this is caught by incremental sync.
    await trx
      .updateTable('sync_states')
      .set({ checkpoint: profile.checkpoint, checkpoint_updated_at: sql`now()` })
      .where('mail_account_id', '=', ctx.accountId)
      .execute();
    await trx
      .updateTable('sync_runs')
      .set({ status: 'failed', error_code: 'superseded', finished_at: sql`now()` })
      .where('mail_account_id', '=', ctx.accountId)
      .where('kind', '=', 'gap_recovery')
      .where('status', '=', 'running')
      .execute();
    await trx
      .insertInto('sync_runs')
      .values({
        id: uuidv7(),
        mail_account_id: ctx.accountId,
        kind: 'gap_recovery',
        query_version: QUERY_VERSION,
        window_start: since,
      })
      .execute();
    if (state.backfill_state === 'done') await setAccountStatus(trx, ctx.accountId, 'recovering');
  });
}

/** Pages through the search queries of every running run. Returns false if stopped by the budget. */
async function runEnumeration(ctx: Ctx): Promise<boolean> {
  const runs = await ctx.db
    .selectFrom('sync_runs')
    .selectAll()
    .where('mail_account_id', '=', ctx.accountId)
    .where('status', '=', 'running')
    .orderBy('started_at')
    .execute();

  // Every run lists at least one page, so a run always makes progress even on a tiny budget.
  let pages = 0;
  for (const run of runs) {
    for (const [family, query] of Object.entries(candidateQueries(run.window_start))) {
      let cursor = run.cursor[family];
      while (cursor !== 'done') {
        if (pages++ > 0 && budgetExhausted(ctx)) return false;
        const page = await ctx.provider.listMessages(query, cursor);
        const next = page.nextPageToken ?? 'done';
        await ctx.db.transaction().execute(async (trx) => {
          await renewLease(trx, ctx.lease);
          const inserted = await insertRefs(trx, ctx, page.refs, run.id);
          await trx
            .updateTable('sync_runs')
            .set({
              cursor: sql`cursor || ${JSON.stringify({ [family]: next })}::jsonb`,
              listed: sql`listed + ${inserted}`,
            })
            .where('id', '=', run.id)
            .execute();
        });
        cursor = next;
      }
    }
    if (run.kind === 'backfill') {
      await ctx.db
        .updateTable('sync_states')
        .set({ backfill_state: 'fetching' })
        .where('mail_account_id', '=', ctx.accountId)
        .where('backfill_state', '=', 'enumerating')
        .execute();
    }
  }
  return true;
}

/**
 * Fetches discovered messages in batches, classifies them, and records the results
 * (sync/record.ts). Email bodies exist only in memory during this step.
 */
async function processPending(ctx: Ctx): Promise<void> {
  const user = await loadUser(ctx);
  const recordDeps: RecordDeps = { pepper: ctx.deps.pepper, contentKey: ctx.deps.contentKey, userId: ctx.userId, timeZone: user.timezone };

  // Phase 1: sort every email with the rules straight away (fast: no AI waiting), so applications
  // appear within minutes. Emails the AI should double-check are queued for phase 2.
  for (let batch = 0; batch === 0 || !budgetExhausted(ctx); batch++) {
    const rows = await ctx.db
      .selectFrom('source_messages')
      .select(['id', 'provider_message_id', 'attempts', 'discovered_by_run_id'])
      .where('mail_account_id', '=', ctx.accountId)
      .where('state', 'in', ['discovered', 'retry'])
      .where('next_attempt_at', '<=', sql<Date>`now()`)
      .orderBy('discovered_at')
      .limit(FETCH_BATCH)
      .execute();
    if (rows.length === 0) return;

    const results = await fetchForAnalysis(ctx.provider, rows);

    await ctx.db.transaction().execute(async (trx) => {
      await renewLease(trx, ctx.lease);
      for (const row of rows) {
        const result: Fetched = results.get(row.provider_message_id) ?? { kind: 'error', id: row.provider_message_id, code: 'missing_result' };
        const attempts = row.attempts + 1;
        const update = trx.updateTable('source_messages').where('id', '=', row.id);

        if (result.kind === 'ok') {
          const analysis = await analyzeHybrid(result.message, { timeZone: user.timezone, ai: null });
          const aiState = ctx.deps.ai && needsAiCheck(result.message, analysis) ? 'pending' : null;
          await recordFetched(trx, recordDeps, row.id, result, analysis, attempts, aiState);
        } else if (result.kind === 'triaged_out') {
          await recordFetched(trx, recordDeps, row.id, result, null, attempts, null);
        } else if (result.kind === 'gone') {
          await update.set({ state: 'skipped_gone', attempts, processed_at: sql`now()` }).execute();
        } else {
          // A broken message never blocks the rest: retry later with backoff, then give up.
          const giveUp = attempts >= MAX_MESSAGE_ATTEMPTS;
          await update
            .set({
              state: giveUp ? 'failed' : 'retry',
              attempts,
              last_error_code: result.code,
              next_attempt_at: sql`now() + make_interval(mins => ${2 ** row.attempts})`,
              processed_at: giveUp ? sql`now()` : null,
            })
            .execute();
        }
      }
    });
    ctx.processed += rows.length;
  }
}

/**
 * Phase 2: the AI double-checks emails the rules sorted, newest first, within the free tier's pace.
 * Each result replaces the rules' answer. Returns true if anything was updated (the caller then
 * rebuilds the applications). If the AI is rate-limited or down, the emails simply wait.
 */
async function refineWithAi(ctx: Ctx): Promise<boolean> {
  if (!ctx.deps.ai) return false;
  const user = await loadUser(ctx);
  const recordDeps: RecordDeps = { pepper: ctx.deps.pepper, contentKey: ctx.deps.contentKey, userId: ctx.userId, timeZone: user.timezone };
  const ai = { classifier: ctx.deps.ai, privacy: await privacyContext(ctx, user.primary_email, user.display_name) };
  let changed = false;

  for (let batch = 0; batch === 0 || !budgetExhausted(ctx); batch++) {
    const rows = await ctx.db
      .selectFrom('source_messages')
      .select(['id', 'provider_message_id', 'attempts'])
      .where('mail_account_id', '=', ctx.accountId)
      .where('ai_state', '=', 'pending')
      .where((eb) => eb.or([eb('ai_retry_at', 'is', null), eb('ai_retry_at', '<=', sql<Date>`now()`)]))
      .orderBy('internal_date', 'desc')
      .limit(AI_BATCH)
      .execute();
    if (rows.length === 0) return changed;

    const fetched = new Map<string, FetchResult>();
    for (const result of await ctx.provider.getMessages(rows.map((r) => r.provider_message_id), 'full')) {
      fetched.set(result.kind === 'ok' ? result.message.id : result.id, result);
    }

    // AI calls happen outside the transaction (they're slow); the lease is renewed after each.
    const analyses = new Map<string, { analysis: Analysis; message: Extract<FetchResult, { kind: 'ok' }> }>();
    const gone: string[] = [];
    let pausedUntil: number | null = null;
    for (const row of rows) {
      const result = fetched.get(row.provider_message_id);
      if (!result || result.kind !== 'ok') {
        gone.push(row.id);
        continue;
      }
      if (pausedUntil) continue;
      try {
        analyses.set(row.id, { analysis: await analyzeHybrid(result.message, { timeZone: user.timezone, ai }), message: result });
      } catch (err) {
        if (err instanceof AiRateLimitedError) pausedUntil = Date.now() + err.retryAfterMs;
        else if (err instanceof AiUnavailableError) pausedUntil = Date.now() + 2 * MINUTE_MS;
        else if (err instanceof AiBadResponseError) analyses.set(row.id, { analysis: rulesFallback(result.message, user.timezone), message: result });
        else throw err;
      }
      await renewLease(ctx.db, ctx.lease);
      if (Date.now() - ctx.startedAt >= ctx.budget.maxMillis) break;
    }

    await ctx.db.transaction().execute(async (trx) => {
      await renewLease(trx, ctx.lease);
      for (const row of rows) {
        const done = analyses.get(row.id);
        if (done) {
          await recordFetched(trx, recordDeps, row.id, done.message, done.analysis, row.attempts, 'done');
          changed = true;
        } else if (gone.includes(row.id)) {
          await trx.updateTable('source_messages').set({ ai_state: 'done' }).where('id', '=', row.id).execute();
        } else if (pausedUntil) {
          await trx.updateTable('source_messages').set({ ai_retry_at: new Date(pausedUntil) }).where('id', '=', row.id).execute();
        }
      }
    });
    ctx.processed += analyses.size;
    if (pausedUntil) {
      ctx.deps.logger.info({ accountId: ctx.accountId, status: 'ai_waiting', durationMs: pausedUntil - Date.now() }, 'AI rate limit reached; AI checks wait');
      return changed;
    }
    if (Date.now() - ctx.startedAt >= ctx.budget.maxMillis) return changed;
  }
  return changed;
}

async function hasDueAiWork(ctx: Ctx): Promise<boolean> {
  if (!ctx.deps.ai) return false;
  const row = await ctx.db
    .selectFrom('source_messages')
    .select('id')
    .where('mail_account_id', '=', ctx.accountId)
    .where('ai_state', '=', 'pending')
    .where((eb) => eb.or([eb('ai_retry_at', 'is', null), eb('ai_retry_at', '<=', sql<Date>`now()`)]))
    .limit(1)
    .executeTakeFirst();
  return !!row;
}

function loadUser(ctx: Ctx) {
  return ctx.db
    .selectFrom('users')
    .select(['timezone', 'display_name', 'primary_email'])
    .where('id', '=', ctx.userId)
    .executeTakeFirstOrThrow();
}

/** What the AI must never see: the user's own addresses and name. */
async function privacyContext(ctx: Ctx, primaryEmail: string, displayName: string | null): Promise<PrivacyContext> {
  const accounts = await ctx.db.selectFrom('mail_accounts').select('address').where('user_id', '=', ctx.userId).execute();
  return { ownAddresses: [...new Set([primaryEmail, ...accounts.map((a) => a.address)])], userName: displayName };
}

/**
 * When the classifier improves (CLASSIFIER_VERSION bump), re-process this mailbox's emails with
 * the new rules, and rebuild the user's applications from the new results. Bodies were never
 * stored, so they're fetched again (about 20 quota units each, once).
 */
async function requeueOutdated(ctx: Ctx): Promise<void> {
  const result = await ctx.db
    .updateTable('source_messages')
    .set({ state: 'discovered', attempts: 0, next_attempt_at: sql`now()`, processed_at: null, last_error_code: null, ai_state: null, ai_retry_at: null })
    .where('mail_account_id', '=', ctx.accountId)
    .where('state', 'in', ['awaiting_match', 'matched', 'irrelevant', 'duplicate'])
    .where((eb) => eb.or([eb('classifier_version', 'is', null), eb('classifier_version', '<', CLASSIFIER_VERSION)]))
    .executeTakeFirst();
  const requeued = Number(result.numUpdatedRows);
  if (requeued > 0) {
    await resetApplications(ctx.db, ctx.userId);
    ctx.deps.logger.info({ accountId: ctx.accountId, count: requeued }, 'classifier updated: re-processing emails');
  }
}

async function hasDueWork(ctx: Ctx): Promise<boolean> {
  const row = await ctx.db
    .selectFrom('source_messages')
    .select('id')
    .where('mail_account_id', '=', ctx.accountId)
    .where('state', 'in', ['discovered', 'retry'])
    .where('next_attempt_at', '<=', sql<Date>`now()`)
    .limit(1)
    .executeTakeFirst();
  return !!row;
}

/** Marks runs finished once everything they found has been processed (or given up on). */
async function completeRuns(ctx: Ctx): Promise<void> {
  const unfinished = await ctx.db
    .selectFrom('source_messages')
    .select('id')
    .where('mail_account_id', '=', ctx.accountId)
    .where('state', 'in', ['discovered', 'retry'])
    .limit(1)
    .executeTakeFirst();
  if (unfinished) return;

  await ctx.db.transaction().execute(async (trx) => {
    const finished = await trx
      .updateTable('sync_runs')
      .set({ status: 'succeeded', finished_at: sql`now()` })
      .where('mail_account_id', '=', ctx.accountId)
      .where('status', '=', 'running')
      .returning('kind')
      .execute();
    if (finished.some((run) => run.kind === 'backfill')) {
      await trx
        .updateTable('sync_states')
        .set({ backfill_state: 'done', backfill_completed_at: sql`now()` })
        .where('mail_account_id', '=', ctx.accountId)
        .execute();
    }
  });
}

// ---- bookkeeping ---------------------------------------------------------------------------------

async function insertRefs(db: Kysely<Database>, ctx: Ctx, refs: MessageRef[], runId: string | null): Promise<number> {
  const unique = [...new Map(refs.map((r) => [r.id, r])).values()];
  if (unique.length === 0) return 0;
  const result = await db
    .insertInto('source_messages')
    .values(
      unique.map((ref) => ({
        id: uuidv7(),
        user_id: ctx.userId,
        mail_account_id: ctx.accountId,
        provider_message_id: ref.id,
        provider_thread_id: ref.threadId,
        discovered_by_run_id: runId,
      })),
    )
    .onConflict((oc) => oc.columns(['mail_account_id', 'provider_message_id']).doNothing())
    .executeTakeFirst();
  return Number(result.numInsertedOrUpdatedRows ?? 0);
}

async function setAccountStatus(db: Kysely<Database>, accountId: string, status: MailAccountStatus, reason: string | null = null) {
  await db
    .updateTable('mail_accounts')
    .set({ status, status_reason: reason, updated_at: sql`now()` })
    .where('id', '=', accountId)
    // Never override a user's decision or a pending disconnect.
    .where('status', 'not in', ['disconnecting', 'paused'])
    .execute();
}

/** How long until the next routine sync, by how recently the user used the app (docs/plan Â§6.6). */
export function syncIntervalMs(lastActiveAt: Date | null, now = new Date()): number {
  const idle = lastActiveAt ? now.getTime() - lastActiveAt.getTime() : Infinity;
  if (idle <= 7 * 24 * 3600 * 1000) return 10 * MINUTE_MS;
  if (idle <= 30 * 24 * 3600 * 1000) return 60 * MINUTE_MS;
  return 12 * 60 * MINUTE_MS;
}

async function recordSuccess(ctx: Ctx, moreWork: boolean): Promise<void> {
  const random = ctx.deps.random ?? Math.random;
  const [state, user, gapRun] = await Promise.all([
    loadState(ctx),
    ctx.db.selectFrom('users').select('last_active_at').where('id', '=', ctx.userId).executeTakeFirstOrThrow(),
    ctx.db
      .selectFrom('sync_runs')
      .select('id')
      .where('mail_account_id', '=', ctx.accountId)
      .where('kind', '=', 'gap_recovery')
      .where('status', '=', 'running')
      .executeTakeFirst(),
  ]);
  const delay = moreWork ? 0 : syncIntervalMs(user.last_active_at) * (0.9 + 0.2 * random());

  await ctx.db.transaction().execute(async (trx) => {
    await renewLease(trx, ctx.lease);
    await trx
      .updateTable('sync_states')
      .set({
        last_success_at: sql`now()`,
        consecutive_failures: 0,
        first_failure_at: null,
        last_error_code: null,
        next_sync_at: sql`now() + make_interval(secs => ${delay / 1000})`,
      })
      .where('mail_account_id', '=', ctx.accountId)
      .execute();
    const status: MailAccountStatus =
      state.backfill_state !== 'done' ? 'backfilling' : gapRun ? 'recovering' : 'active';
    await setAccountStatus(trx, ctx.accountId, status);
  });
}

async function recordFailure(ctx: Ctx, code: string): Promise<void> {
  const random = ctx.deps.random ?? Math.random;
  const state = await loadState(ctx);
  const failures = state.consecutive_failures + 1;
  const firstFailureAt = state.first_failure_at ?? new Date();
  // Back off: 2, 4, 8 â€¦ minutes, capped at 6 hours, with jitter.
  const delayMs = Math.min(6 * 60 * MINUTE_MS, 2 ** failures * MINUTE_MS) * (0.5 + random() * 0.5);

  await ctx.db
    .updateTable('sync_states')
    .set({
      consecutive_failures: failures,
      first_failure_at: firstFailureAt,
      last_error_code: code,
      next_sync_at: sql`now() + make_interval(secs => ${delayMs / 1000})`,
    })
    .where('mail_account_id', '=', ctx.accountId)
    .where('lease_version', '=', ctx.lease.version)
    .execute();
  if (Date.now() - firstFailureAt.getTime() >= ERROR_AFTER_MS) await setAccountStatus(ctx.db, ctx.accountId, 'error', code);
}

async function markReauthRequired(ctx: Ctx, code: string): Promise<void> {
  await ctx.db
    .updateTable('sync_states')
    .set({ last_error_code: code })
    .where('mail_account_id', '=', ctx.accountId)
    .execute();
  await setAccountStatus(ctx.db, ctx.accountId, 'reauth_required', code);
}

function errorCode(err: unknown): string {
  if (err instanceof ProviderUnavailableError) return err.code;
  if (err instanceof GmailApiError) return `gmail_${err.status}_${err.reason}`;
  return err instanceof Error ? err.name : 'unknown';
}
