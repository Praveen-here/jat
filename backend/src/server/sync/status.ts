import type { Kysely } from 'kysely';
import type { BackfillState, Database } from '../db/pool';

/** What the Settings page shows per mailbox. Counts only, no email content. */
export interface SyncSummary {
  backfillState: BackfillState | null;
  windowStart: Date | null;
  lastSuccessAt: Date | null;
  nextSyncAt: Date | null;
  lastErrorCode: string | null;
  /** Emails found by the search so far. */
  found: number;
  /** Of those, how many have been sorted (by the rules, phase 1). */
  processed: number;
  failed: number;
  /** AI double-check (phase 2): waiting and finished. */
  aiPending: number;
  aiDone: number;
}

export async function syncSummaries(db: Kysely<Database>, userId: string): Promise<Map<string, SyncSummary>> {
  const [states, counts] = await Promise.all([
    db
      .selectFrom('sync_states')
      .innerJoin('mail_accounts', 'mail_accounts.id', 'sync_states.mail_account_id')
      .select([
        'sync_states.mail_account_id as accountId',
        'sync_states.backfill_state',
        'sync_states.backfill_window_start',
        'sync_states.last_success_at',
        'sync_states.next_sync_at',
        'sync_states.last_error_code',
      ])
      .where('mail_accounts.user_id', '=', userId)
      .execute(),
    db
      .selectFrom('source_messages')
      .select(['mail_account_id', 'state', 'ai_state', (eb) => eb.fn.countAll<string>().as('n')])
      .where('user_id', '=', userId)
      .groupBy(['mail_account_id', 'state', 'ai_state'])
      .execute(),
  ]);

  const summaries = new Map<string, SyncSummary>();
  for (const s of states) {
    summaries.set(s.accountId, {
      backfillState: s.backfill_state,
      windowStart: s.backfill_window_start,
      lastSuccessAt: s.last_success_at,
      nextSyncAt: s.next_sync_at,
      lastErrorCode: s.last_error_code,
      found: 0,
      processed: 0,
      failed: 0,
      aiPending: 0,
      aiDone: 0,
    });
  }
  for (const c of counts) {
    const summary = summaries.get(c.mail_account_id);
    if (!summary) continue;
    const n = Number(c.n);
    summary.found += n;
    if (c.state !== 'discovered' && c.state !== 'retry') summary.processed += n;
    if (c.state === 'failed') summary.failed += n;
    if (c.ai_state === 'pending') summary.aiPending += n;
    if (c.ai_state === 'done') summary.aiDone += n;
  }
  return summaries;
}
