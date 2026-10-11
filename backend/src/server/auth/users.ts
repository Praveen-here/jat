import { sql, type Kysely } from 'kysely';
import { v7 as uuidv7 } from 'uuid';
import type { Database } from '../db/pool';
import type { GoogleIdentity } from './google';

export interface AppUser {
  id: string;
  email: string;
  displayName: string | null;
}

const UNIQUE_VIOLATION = '23505';

/** Finds the user for a Google identity (by `sub`), creating the user on first sign-in. */
export async function upsertGoogleUser(db: Kysely<Database>, identity: GoogleIdentity): Promise<AppUser> {
  try {
    return await upsertOnce(db, identity);
  } catch (err) {
    // Two first-time sign-ins racing: the loser hits the unique constraint; the retry finds the row.
    if ((err as { code?: string }).code === UNIQUE_VIOLATION) return upsertOnce(db, identity);
    throw err;
  }
}

function upsertOnce(db: Kysely<Database>, identity: GoogleIdentity): Promise<AppUser> {
  return db.transaction().execute(async (trx) => {
    const existing = await trx
      .selectFrom('auth_identities')
      .select('user_id')
      .where('provider', '=', 'google')
      .where('provider_subject', '=', identity.subject)
      .executeTakeFirst();

    if (existing) {
      await trx
        .updateTable('auth_identities')
        .set({ email: identity.email, last_login_at: sql`now()` })
        .where('provider', '=', 'google')
        .where('provider_subject', '=', identity.subject)
        .execute();
      const user = await trx
        .updateTable('users')
        .set({ primary_email: identity.email, display_name: identity.name, last_active_at: sql`now()` })
        .where('id', '=', existing.user_id)
        .where('deleted_at', 'is', null)
        .returning(['id', 'primary_email', 'display_name'])
        .executeTakeFirstOrThrow();
      return { id: user.id, email: user.primary_email, displayName: user.display_name };
    }

    const userId = uuidv7();
    await trx
      .insertInto('users')
      .values({ id: userId, primary_email: identity.email, display_name: identity.name, last_active_at: new Date() })
      .execute();
    await trx
      .insertInto('auth_identities')
      .values({
        id: uuidv7(),
        user_id: userId,
        provider: 'google',
        provider_subject: identity.subject,
        email: identity.email,
      })
      .execute();
    return { id: userId, email: identity.email, displayName: identity.name };
  });
}
