import { sql, type Kysely } from 'kysely';
import type { Database } from '../db/pool';

/**
 * At most one worker syncs a mailbox at a time (docs/plan §6.7).
 * Acquiring bumps `lease_version`, a fencing token: writes made under a lease include
 * `lease_version = <mine>`, so a worker that stalled past its lease can't overwrite progress
 * made by whoever took over.
 */
export const LEASE_TTL_SECONDS = 5 * 60;

export interface Lease {
  accountId: string;
  version: string;
}

export class LeaseLostError extends Error {
  constructor() {
    super('Sync lease lost to another worker');
    this.name = 'LeaseLostError';
  }
}

export async function acquireLease(db: Kysely<Database>, accountId: string, owner: string): Promise<Lease | null> {
  const row = await db
    .updateTable('sync_states')
    .set({
      lease_owner: owner,
      lease_expires_at: sql`now() + make_interval(secs => ${LEASE_TTL_SECONDS})`,
      lease_version: sql`lease_version + 1`,
    })
    .where('mail_account_id', '=', accountId)
    .where((eb) => eb.or([eb('lease_expires_at', 'is', null), eb('lease_expires_at', '<', sql<Date>`now()`)]))
    .returning('lease_version')
    .executeTakeFirst();
  return row ? { accountId, version: String(row.lease_version) } : null;
}

/** Extends the lease. Throws LeaseLostError if someone else took it. */
export async function renewLease(db: Kysely<Database>, lease: Lease): Promise<void> {
  const result = await db
    .updateTable('sync_states')
    .set({ lease_expires_at: sql`now() + make_interval(secs => ${LEASE_TTL_SECONDS})` })
    .where('mail_account_id', '=', lease.accountId)
    .where('lease_version', '=', lease.version)
    .executeTakeFirst();
  if (Number(result.numUpdatedRows) === 0) throw new LeaseLostError();
}

export async function releaseLease(db: Kysely<Database>, lease: Lease): Promise<void> {
  await db
    .updateTable('sync_states')
    .set({ lease_owner: null, lease_expires_at: null })
    .where('mail_account_id', '=', lease.accountId)
    .where('lease_version', '=', lease.version)
    .execute();
}
