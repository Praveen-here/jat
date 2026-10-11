import type { Kysely } from 'kysely';
import type { Database } from '../db/pool';
import { randomToken, sha256Hex } from './crypto';
import type { AppUser } from './users';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** Signed out after 7 days without use, and after 30 days no matter what. */
export const SESSION_IDLE_MS = 7 * DAY_MS;
export const SESSION_ABSOLUTE_MS = 30 * DAY_MS;
/** Avoid a database write on every request: extend the idle window at most hourly. */
const TOUCH_INTERVAL_MS = HOUR_MS;

export interface CreatedSession {
  token: string;
  absoluteExpiresAt: Date;
}

export async function createSession(
  db: Kysely<Database>,
  userId: string,
  now: Date = new Date(),
): Promise<CreatedSession> {
  const token = randomToken();
  const absoluteExpiresAt = new Date(now.getTime() + SESSION_ABSOLUTE_MS);
  await db
    .insertInto('sessions')
    .values({
      id_hash: sha256Hex(token),
      user_id: userId,
      created_at: now,
      last_seen_at: now,
      idle_expires_at: new Date(now.getTime() + SESSION_IDLE_MS),
      absolute_expires_at: absoluteExpiresAt,
    })
    .execute();
  return { token, absoluteExpiresAt };
}

/** Returns the signed-in user for a session token, or null if missing, expired or revoked. */
export async function findSessionUser(
  db: Kysely<Database>,
  token: string | undefined,
  now: Date = new Date(),
): Promise<AppUser | null> {
  if (!token) return null;
  const idHash = sha256Hex(token);
  const row = await db
    .selectFrom('sessions')
    .innerJoin('users', 'users.id', 'sessions.user_id')
    .select([
      'users.id as userId',
      'users.primary_email as email',
      'users.display_name as displayName',
      'sessions.last_seen_at as lastSeenAt',
      'sessions.absolute_expires_at as absoluteExpiresAt',
    ])
    .where('sessions.id_hash', '=', idHash)
    .where('sessions.revoked_at', 'is', null)
    .where('sessions.idle_expires_at', '>', now)
    .where('sessions.absolute_expires_at', '>', now)
    .where('users.deleted_at', 'is', null)
    .executeTakeFirst();
  if (!row) return null;

  if (now.getTime() - row.lastSeenAt.getTime() > TOUCH_INTERVAL_MS) {
    const idle = Math.min(now.getTime() + SESSION_IDLE_MS, row.absoluteExpiresAt.getTime());
    await db
      .updateTable('sessions')
      .set({ last_seen_at: now, idle_expires_at: new Date(idle) })
      .where('id_hash', '=', idHash)
      .execute();
  }
  return { id: row.userId, email: row.email, displayName: row.displayName };
}

export async function revokeSession(db: Kysely<Database>, token: string | undefined): Promise<void> {
  if (!token) return;
  await db
    .updateTable('sessions')
    .set({ revoked_at: new Date() })
    .where('id_hash', '=', sha256Hex(token))
    .where('revoked_at', 'is', null)
    .execute();
}
