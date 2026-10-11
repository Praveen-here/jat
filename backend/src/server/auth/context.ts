import type { Env } from '../config/env';
import { keyEncryptionKeyFromBase64, type KeyEncryptionKey } from '../crypto/vault';
import { getRuntime } from '../runtime';
import { cookieNames, readCookie, type CookieNames } from './cookies';
import type { GoogleClientConfig } from './google';
import { findSessionUser } from './sessions';
import type { AppUser } from './users';

export interface AuthSettings {
  appUrl: string;
  secure: boolean;
  cookies: CookieNames;
}

export function authSettings(env: Env): AuthSettings {
  const appUrl = env.APP_URL.replace(/\/+$/, '');
  const secure = appUrl.startsWith('https://');
  return { appUrl, secure, cookies: cookieNames(secure) };
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

/** Google client for a given callback path (sign-in and, later, mailbox connection). */
export function googleClient(env: Env, callbackPath: string): GoogleClientConfig {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
    throw new ConfigError('GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set in .env (see docs/SETUP.md)');
  }
  return {
    clientId: env.GOOGLE_CLIENT_ID,
    clientSecret: env.GOOGLE_CLIENT_SECRET,
    redirectUri: `${authSettings(env).appUrl}${callbackPath}`,
  };
}

export const LOGIN_CALLBACK_PATH = '/api/auth/google/callback';
export const MAILBOX_CALLBACK_PATH = '/api/auth/google/mailbox/callback';

/** OAuth client credentials without a redirect (the worker only refreshes tokens). */
export function googleCredentials(env: Env): { clientId: string; clientSecret: string } {
  const { clientId, clientSecret } = googleClient(env, '');
  return { clientId, clientSecret };
}

/** Secret for keyed fingerprints of email identifiers (Message-ID). */
export function hmacPepper(env: Env): string {
  if (!env.HMAC_PEPPER) throw new ConfigError('HMAC_PEPPER must be set in .env (see docs/SETUP.md)');
  return env.HMAC_PEPPER;
}

/** The key that encrypts stored Gmail refresh tokens. */
export function tokenEncryptionKey(env: Env): KeyEncryptionKey {
  if (!env.TOKEN_ENCRYPTION_KEY) {
    throw new ConfigError('TOKEN_ENCRYPTION_KEY must be set in .env (see docs/SETUP.md)');
  }
  return keyEncryptionKeyFromBase64(env.TOKEN_ENCRYPTION_KEY);
}

/** The signed-in user for this request, or null. */
export async function currentUser(request: Request): Promise<AppUser | null> {
  const { db, env } = getRuntime();
  return findSessionUser(db, readCookie(request, authSettings(env).cookies.session));
}
