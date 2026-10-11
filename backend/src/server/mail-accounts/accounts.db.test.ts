import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { upsertGoogleUser } from '../auth/users';
import { keyEncryptionKeyFromBase64 } from '../crypto/vault';
import { setupTestDb, TEST_DATABASE_URL, type TestDb } from '../testing/test-db';
import {
  disconnectMailAccount,
  linkGmailAccount,
  listMailAccounts,
  loadRefreshToken,
  MAX_MAIL_ACCOUNTS_PER_USER,
} from './accounts';

const kek = keyEncryptionKeyFromBase64(randomBytes(32).toString('base64'));
const REFRESH_TOKEN = '1//0gRefreshTokenForTests';

describe.skipIf(!TEST_DATABASE_URL)('mail accounts (database)', () => {
  let t: TestDb;
  let alice: string;
  let bob: string;

  beforeAll(async () => {
    t = await setupTestDb();
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    await t.reset();
    alice = (await upsertGoogleUser(t.db, { subject: 'a', email: 'alice@gmail.com', emailVerified: true, name: 'A' })).id;
    bob = (await upsertGoogleUser(t.db, { subject: 'b', email: 'bob@gmail.com', emailVerified: true, name: 'B' })).id;
  });

  const link = (userId: string, subject: string, token = REFRESH_TOKEN) =>
    linkGmailAccount(t.db, kek, {
      userId,
      providerSubject: subject,
      address: `${subject}@gmail.com`,
      grantedScopes: ['openid', 'https://www.googleapis.com/auth/gmail.readonly'],
      refreshToken: token,
    });

  it('links several mailboxes to one user', async () => {
    expect(await link(alice, 'personal')).toMatchObject({ ok: true, reconnected: false });
    expect(await link(alice, 'college')).toMatchObject({ ok: true, reconnected: false });
    expect((await listMailAccounts(t.db, alice)).map((a) => a.address)).toEqual([
      'personal@gmail.com',
      'college@gmail.com',
    ]);
  });

  it('stores the refresh token encrypted, never in plain text', async () => {
    const result = await link(alice, 'personal');
    const { rows } = await t.pool.query('select * from app.mail_account_credentials');
    expect(JSON.stringify(rows)).not.toContain(REFRESH_TOKEN);
    expect(Buffer.concat([rows[0].refresh_token_ciphertext, rows[0].wrapped_dek]).toString('latin1')).not.toContain(
      REFRESH_TOKEN,
    );
    expect(await loadRefreshToken(t.db, kek, (result as { accountId: string }).accountId)).toBe(REFRESH_TOKEN);
  });

  it('reconnecting the same mailbox replaces its token instead of duplicating it', async () => {
    const first = await link(alice, 'personal', 'old-token');
    const second = await link(alice, 'personal', 'new-token');
    expect(second).toMatchObject({ ok: true, reconnected: true });
    const id = (first as { accountId: string }).accountId;
    expect((second as { accountId: string }).accountId).toBe(id);
    expect(await loadRefreshToken(t.db, kek, id)).toBe('new-token');
    expect(await listMailAccounts(t.db, alice)).toHaveLength(1);
  });

  it("refuses a mailbox already linked to someone else's account", async () => {
    await link(alice, 'shared');
    expect(await link(bob, 'shared')).toEqual({ ok: false, reason: 'linked_elsewhere' });
    expect(await listMailAccounts(t.db, bob)).toHaveLength(0);
  });

  it(`stops at ${MAX_MAIL_ACCOUNTS_PER_USER} mailboxes per user`, async () => {
    for (let i = 0; i < MAX_MAIL_ACCOUNTS_PER_USER; i++) await link(alice, `box${i}`);
    expect(await link(alice, 'one-too-many')).toEqual({ ok: false, reason: 'limit_reached' });
  });

  it('a token copied onto another account row cannot be decrypted', async () => {
    const a = (await link(alice, 'personal')) as { accountId: string };
    const b = (await link(alice, 'college', 'other')) as { accountId: string };
    await t.pool.query(
      `update app.mail_account_credentials set (kek_id, wrapped_dek, token_iv, refresh_token_ciphertext) =
         (select kek_id, wrapped_dek, token_iv, refresh_token_ciphertext from app.mail_account_credentials where mail_account_id = $1)
       where mail_account_id = $2`,
      [a.accountId, b.accountId],
    );
    await expect(loadRefreshToken(t.db, kek, b.accountId)).rejects.toThrow();
  });

  describe('disconnect', () => {
    it('deletes the account and its credentials, then revokes the token at Google', async () => {
      const { accountId } = (await link(alice, 'personal')) as { accountId: string };
      const revoke = vi.fn(async () => undefined);

      expect(await disconnectMailAccount(t.db, kek, { userId: alice, mailAccountId: accountId, revoke })).toEqual({
        ok: true,
        revoked: true,
      });
      expect(revoke).toHaveBeenCalledWith(REFRESH_TOKEN);
      const { rows } = await t.pool.query(
        'select (select count(*) from app.mail_accounts)::int as a, (select count(*) from app.mail_account_credentials)::int as c',
      );
      expect(rows[0]).toEqual({ a: 0, c: 0 });
    });

    it('still deletes locally when Google revocation fails', async () => {
      const { accountId } = (await link(alice, 'personal')) as { accountId: string };
      const result = await disconnectMailAccount(t.db, kek, {
        userId: alice,
        mailAccountId: accountId,
        revoke: async () => {
          throw new Error('network down');
        },
      });
      expect(result).toEqual({ ok: true, revoked: false });
      expect(await listMailAccounts(t.db, alice)).toHaveLength(0);
    });

    it("cannot disconnect another user's mailbox", async () => {
      const { accountId } = (await link(alice, 'personal')) as { accountId: string };
      const revoke = vi.fn(async () => undefined);
      expect(await disconnectMailAccount(t.db, kek, { userId: bob, mailAccountId: accountId, revoke })).toEqual({
        ok: false,
        reason: 'not_found',
      });
      expect(revoke).not.toHaveBeenCalled();
      expect(await listMailAccounts(t.db, alice)).toHaveLength(1);
    });
  });

  it('deleting a user removes their mailboxes and credentials', async () => {
    await link(alice, 'personal');
    await t.pool.query('delete from app.users where id = $1', [alice]);
    const { rows } = await t.pool.query('select count(*)::int as n from app.mail_account_credentials');
    expect(rows[0].n).toBe(0);
  });
});
