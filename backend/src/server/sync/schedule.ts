import { sql, type Kysely } from 'kysely';
import type { Database } from '../db/pool';
import { BACKFILL_MONTHS, SYNCABLE_STATUSES } from './engine';

/**
 * Self-healing: gives every syncable mailbox a sync state. Normally the connect step creates it,
 * but a mailbox connected before sync existed (or a failed insert) would otherwise never sync.
 */
export async function ensureMissingSyncStates(db: Kysely<Database>): Promise<number> {
  const result = await db
    .insertInto('sync_states')
    .columns(['mail_account_id', 'backfill_window_start', 'next_sync_at'])
    .expression((eb) =>
      eb
        .selectFrom('mail_accounts')
        .select([
          'mail_accounts.id',
          sql<Date>`now() - make_interval(months => ${BACKFILL_MONTHS})`.as('backfill_window_start'),
          sql<Date>`now()`.as('next_sync_at'),
        ])
        .where('mail_accounts.status', 'in', SYNCABLE_STATUSES)
        .where(({ not, exists, selectFrom }) =>
          not(exists(selectFrom('sync_states').select('mail_account_id').whereRef('sync_states.mail_account_id', '=', 'mail_accounts.id'))),
        ),
    )
    .onConflict((oc) => oc.column('mail_account_id').doNothing())
    .executeTakeFirst();
  return Number(result.numInsertedOrUpdatedRows ?? 0);
}

/** Mailboxes whose next sync is due and that nobody is syncing right now. */
export async function findDueAccounts(db: Kysely<Database>, limit = 100): Promise<string[]> {
  const rows = await db
    .selectFrom('sync_states')
    .innerJoin('mail_accounts', 'mail_accounts.id', 'sync_states.mail_account_id')
    .select('sync_states.mail_account_id as id')
    .where('mail_accounts.status', 'in', SYNCABLE_STATUSES)
    .where('sync_states.next_sync_at', '<=', sql<Date>`now()`)
    .where((eb) =>
      eb.or([eb('sync_states.lease_expires_at', 'is', null), eb('sync_states.lease_expires_at', '<', sql<Date>`now()`)]),
    )
    .orderBy('sync_states.next_sync_at')
    .limit(limit)
    .execute();
  return rows.map((r) => r.id);
}

/**
 * "Sync now": asks for a sync at the next scheduler tick (within a minute). Ignored if a sync
 * was attempted in the last 60 seconds, so repeated clicks don't hammer Gmail.
 */
export async function requestSyncNow(db: Kysely<Database>, userId: string, accountId: string): Promise<'queued' | 'too_soon' | 'not_found'> {
  const account = await db
    .selectFrom('mail_accounts')
    .select('id')
    .where('id', '=', accountId)
    .where('user_id', '=', userId)
    .where('status', 'in', SYNCABLE_STATUSES)
    .executeTakeFirst();
  if (!account) return 'not_found';
  const result = await db
    .updateTable('sync_states')
    .set({ next_sync_at: sql`now()` })
    .where('mail_account_id', '=', accountId)
    .where((eb) =>
      eb.or([eb('last_attempt_at', 'is', null), eb('last_attempt_at', '<', sql<Date>`now() - interval '60 seconds'`)]),
    )
    .executeTakeFirst();
  return Number(result.numUpdatedRows) > 0 ? 'queued' : 'too_soon';
}
