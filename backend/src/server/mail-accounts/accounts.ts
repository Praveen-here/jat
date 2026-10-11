import { sql, type Kysely, type Transaction } from 'kysely';
import { v7 as uuidv7 } from 'uuid';
import { openSecret, sealSecret, type KeyEncryptionKey } from '../crypto/vault';
import type { Database, MailAccountStatus } from '../db/pool';

export const MAX_MAIL_ACCOUNTS_PER_USER = 5;

export interface MailAccountSummary {
  id: string;
  address: string;
  status: MailAccountStatus;
  statusReason: string | null;
  connectedAt: Date;
}

/** Binds a ciphertext to its account row (see vault.ts). */
const credentialsAad = (mailAccountId: string) => `mail_account_credentials:${mailAccountId}`;

export async function listMailAccounts(db: Kysely<Database>, userId: string): Promise<MailAccountSummary[]> {
  const rows = await db
    .selectFrom('mail_accounts')
    .select(['id', 'address', 'status', 'status_reason', 'connected_at'])
    .where('user_id', '=', userId)
    .orderBy('connected_at')
    .execute();
  return rows.map((r) => ({
    id: r.id,
    address: r.address,
    status: r.status,
    statusReason: r.status_reason,
    connectedAt: r.connected_at,
  }));
}

export async function countMailAccounts(db: Kysely<Database>, userId: string): Promise<number> {
  const row = await db
    .selectFrom('mail_accounts')
    .select((eb) => eb.fn.countAll<string>().as('n'))
    .where('user_id', '=', userId)
    .executeTakeFirstOrThrow();
  return Number(row.n);
}

export interface LinkGmailInput {
  userId: string;
  /** Google `sub` of the mailbox account. */
  providerSubject: string;
  address: string;
  grantedScopes: string[];
  refreshToken: string;
}

export type LinkResult =
  | { ok: true; accountId: string; reconnected: boolean }
  | { ok: false; reason: 'linked_elsewhere' | 'limit_reached' };

/**
 * Links a Gmail mailbox to a user, or refreshes the credentials of one they already linked
 * (reconnect). Refuses a mailbox already linked to a different user.
 */
export async function linkGmailAccount(
  db: Kysely<Database>,
  kek: KeyEncryptionKey,
  input: LinkGmailInput,
): Promise<LinkResult> {
  return db.transaction().execute(async (trx) => {
    // Serialise concurrent connects of the same mailbox.
    await sql`select pg_advisory_xact_lock(hashtext(${`gmail:${input.providerSubject}`}))`.execute(trx);

    const existing = await trx
      .selectFrom('mail_accounts')
      .select(['id', 'user_id'])
      .where('provider', '=', 'gmail')
      .where('provider_subject', '=', input.providerSubject)
      .executeTakeFirst();

    if (existing && existing.user_id !== input.userId) return { ok: false, reason: 'linked_elsewhere' };

    if (existing) {
      await trx
        .updateTable('mail_accounts')
        .set({
          address: input.address,
          granted_scopes: input.grantedScopes,
          status: 'connected',
          status_reason: null,
          updated_at: sql`now()`,
        })
        .where('id', '=', existing.id)
        .execute();
      await storeRefreshToken(trx, kek, existing.id, input.refreshToken);
      return { ok: true, accountId: existing.id, reconnected: true };
    }

    if ((await countMailAccounts(trx, input.userId)) >= MAX_MAIL_ACCOUNTS_PER_USER) {
      return { ok: false, reason: 'limit_reached' };
    }

    const accountId = uuidv7();
    await trx
      .insertInto('mail_accounts')
      .values({
        id: accountId,
        user_id: input.userId,
        provider: 'gmail',
        provider_subject: input.providerSubject,
        address: input.address,
        status: 'connected',
        granted_scopes: input.grantedScopes,
      })
      .execute();
    await storeRefreshToken(trx, kek, accountId, input.refreshToken);
    return { ok: true, accountId, reconnected: false };
  });
}

export async function storeRefreshToken(
  db: Kysely<Database> | Transaction<Database>,
  kek: KeyEncryptionKey,
  mailAccountId: string,
  refreshToken: string,
): Promise<void> {
  const sealed = sealSecret(refreshToken, credentialsAad(mailAccountId), kek);
  const values = {
    kek_id: sealed.kekId,
    wrapped_dek: sealed.wrappedDek,
    token_iv: sealed.iv,
    refresh_token_ciphertext: sealed.ciphertext,
  };
  await db
    .insertInto('mail_account_credentials')
    .values({ mail_account_id: mailAccountId, ...values })
    .onConflict((oc) =>
      oc.column('mail_account_id').doUpdateSet({
        ...values,
        obtained_at: sql`now()`,
        last_refresh_error: null,
      }),
    )
    .execute();
}

/** Decrypts an account's refresh token. Used by the sync worker and on disconnect. */
export async function loadRefreshToken(
  db: Kysely<Database>,
  kek: KeyEncryptionKey,
  mailAccountId: string,
): Promise<string | null> {
  const row = await db
    .selectFrom('mail_account_credentials')
    .select(['kek_id', 'wrapped_dek', 'token_iv', 'refresh_token_ciphertext'])
    .where('mail_account_id', '=', mailAccountId)
    .executeTakeFirst();
  if (!row) return null;
  return openSecret(
    { kekId: row.kek_id, wrappedDek: row.wrapped_dek, iv: row.token_iv, ciphertext: row.refresh_token_ciphertext },
    credentialsAad(mailAccountId),
    kek,
  );
}

export type DisconnectResult = { ok: true; revoked: boolean } | { ok: false; reason: 'not_found' };

/**
 * Disconnects a mailbox: deletes the account and everything stored for it (credentials now;
 * synced data once sync exists, via ON DELETE CASCADE), then revokes Google's grant.
 * Local deletion happens even if revocation fails; the token is gone from our side either way.
 */
export async function disconnectMailAccount(
  db: Kysely<Database>,
  kek: KeyEncryptionKey,
  params: { userId: string; mailAccountId: string; revoke: (refreshToken: string) => Promise<void> },
): Promise<DisconnectResult> {
  const account = await db
    .selectFrom('mail_accounts')
    .select('id')
    .where('id', '=', params.mailAccountId)
    .where('user_id', '=', params.userId)
    .executeTakeFirst();
  if (!account) return { ok: false, reason: 'not_found' };

  let refreshToken: string | null = null;
  try {
    refreshToken = await loadRefreshToken(db, kek, account.id);
  } catch {
    // Undecryptable (e.g. key changed): still delete locally; nothing to revoke with.
  }

  await db.deleteFrom('mail_accounts').where('id', '=', account.id).where('user_id', '=', params.userId).execute();

  if (!refreshToken) return { ok: true, revoked: false };
  try {
    await params.revoke(refreshToken);
    return { ok: true, revoked: true };
  } catch {
    return { ok: true, revoked: false };
  }
}
