import { sql, type Kysely } from 'kysely';
import { GoogleOAuthError, refreshAccessToken } from '../auth/google';
import type { KeyEncryptionKey } from '../crypto/vault';
import type { Database } from '../db/pool';
import { GmailProvider } from '../gmail/provider';
import { loadRefreshToken, storeRefreshToken } from '../mail-accounts/accounts';
import { AuthRevokedError, ProviderUnavailableError } from '../mail/provider';
import type { RateLimiters } from './rate-limiter';

/**
 * Builds Gmail providers for the worker. Access tokens (valid about 1 hour) are kept in this
 * process's memory only, never in the database or logs, and refreshed 5 minutes before expiry.
 */
export class GmailAccess {
  private readonly accessTokens = new Map<string, { token: string; expiresAt: number }>();

  constructor(
    private readonly db: Kysely<Database>,
    private readonly kek: KeyEncryptionKey,
    private readonly client: { clientId: string; clientSecret: string },
    private readonly limiters: RateLimiters,
  ) {}

  providerFor(account: { id: string }): GmailProvider {
    return new GmailProvider({
      getAccessToken: (force) => this.accessToken(account.id, force),
      limiter: this.limiters.forAccount(account.id),
    });
  }

  private async accessToken(accountId: string, force: boolean): Promise<string> {
    const cached = this.accessTokens.get(accountId);
    if (!force && cached && cached.expiresAt - 5 * 60_000 > Date.now()) return cached.token;

    const refreshToken = await loadRefreshToken(this.db, this.kek, accountId);
    if (!refreshToken) throw new AuthRevokedError('missing_credentials');

    try {
      const fresh = await refreshAccessToken(this.client, refreshToken);
      if (fresh.refreshToken && fresh.refreshToken !== refreshToken) {
        await storeRefreshToken(this.db, this.kek, accountId, fresh.refreshToken);
      }
      await this.db
        .updateTable('mail_account_credentials')
        .set({ last_refreshed_at: sql`now()`, last_refresh_error: null })
        .where('mail_account_id', '=', accountId)
        .execute();
      this.accessTokens.set(accountId, { token: fresh.accessToken, expiresAt: Date.now() + fresh.expiresIn * 1000 });
      return fresh.accessToken;
    } catch (err) {
      this.accessTokens.delete(accountId);
      if (err instanceof GoogleOAuthError) {
        await this.db
          .updateTable('mail_account_credentials')
          .set({ last_refresh_error: err.code })
          .where('mail_account_id', '=', accountId)
          .execute();
        // invalid_grant: revoked, password changed, unused 6 months, or Testing-mode 7-day expiry.
        if (err.code === 'invalid_grant' || err.code === 'unauthorized_client') throw new AuthRevokedError(err.code);
        throw new ProviderUnavailableError(`token_${err.code}`);
      }
      throw new ProviderUnavailableError('token_refresh_failed');
    }
  }
}
