import { sql, type Kysely } from 'kysely';
import type { Database } from '../db/pool';

/**
 * Deletes rows that no longer serve any purpose (data minimisation):
 * finished or expired OAuth attempts after a day, ended sessions after a week.
 */
export async function cleanupExpiredAuthData(db: Kysely<Database>): Promise<{ flows: number; sessions: number }> {
  const flows = await db
    .deleteFrom('oauth_flows')
    .where('expires_at', '<', sql<Date>`now() - interval '1 day'`)
    .executeTakeFirst();
  const sessions = await db
    .deleteFrom('sessions')
    .where((eb) =>
      eb.or([
        eb('absolute_expires_at', '<', sql<Date>`now() - interval '7 days'`),
        eb('idle_expires_at', '<', sql<Date>`now() - interval '7 days'`),
        eb('revoked_at', '<', sql<Date>`now() - interval '7 days'`),
      ]),
    )
    .executeTakeFirst();
  return { flows: Number(flows.numDeletedRows), sessions: Number(sessions.numDeletedRows) };
}
