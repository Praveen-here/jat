import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';

/**
 * Google OAuth 2.0 / OpenID Connect: authorization URL, code exchange, ID-token verification.
 * Endpoints are Google's documented ones; the signing keys are fetched (and cached) by jose.
 */
const AUTHORIZATION_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const GOOGLE_ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];
const googleKeys = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'));

/** Sign-in only: identity scopes. Mailbox access is a separate flow. */
export const LOGIN_SCOPES = ['openid', 'email', 'profile'] as const;

/** Mailbox connection: read-only Gmail (a restricted scope), plus `openid email` to learn which account. */
export const GMAIL_READONLY_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
export const GMAIL_CONNECT_SCOPES = ['openid', 'email', GMAIL_READONLY_SCOPE] as const;

const REVOKE_ENDPOINT = 'https://oauth2.googleapis.com/revoke';

/** With granular consent the user can untick Gmail, so always check what was actually granted. */
export function hasGrantedScope(grantedScopes: string | undefined, scope: string): boolean {
  return (grantedScopes ?? '').split(' ').includes(scope);
}

export interface GoogleClientConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export interface AuthorizationRequest {
  scopes: readonly string[];
  state: string;
  nonce: string;
  codeChallenge: string;
  prompt?: 'select_account' | 'consent';
  accessType?: 'online' | 'offline';
  loginHint?: string;
}

export function buildAuthorizationUrl(config: GoogleClientConfig, request: AuthorizationRequest): string {
  const url = new URL(AUTHORIZATION_ENDPOINT);
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('redirect_uri', config.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', request.scopes.join(' '));
  url.searchParams.set('state', request.state);
  url.searchParams.set('nonce', request.nonce);
  url.searchParams.set('code_challenge', request.codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  if (request.prompt) url.searchParams.set('prompt', request.prompt);
  if (request.accessType) url.searchParams.set('access_type', request.accessType);
  if (request.loginHint) url.searchParams.set('login_hint', request.loginHint);
  return url.toString();
}

/** Carries Google's short error code only (e.g. "invalid_grant"), never response bodies. */
export class GoogleOAuthError extends Error {
  constructor(readonly code: string) {
    super(`Google OAuth error: ${code}`);
    this.name = 'GoogleOAuthError';
  }
}

export interface TokenResponse {
  idToken: string;
  accessToken: string;
  refreshToken?: string;
  scope?: string;
  expiresIn?: number;
}

export async function exchangeCode(
  config: GoogleClientConfig,
  code: string,
  codeVerifier: string,
  fetchImpl: typeof fetch = fetch,
): Promise<TokenResponse> {
  const response = await fetchImpl(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: config.clientId,
      client_secret: config.clientSecret,
      redirect_uri: config.redirectUri,
      grant_type: 'authorization_code',
      code_verifier: codeVerifier,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    throw new GoogleOAuthError(typeof body.error === 'string' ? body.error : `http_${response.status}`);
  }
  if (typeof body.id_token !== 'string' || typeof body.access_token !== 'string') {
    throw new GoogleOAuthError('malformed_token_response');
  }
  return {
    idToken: body.id_token,
    accessToken: body.access_token,
    refreshToken: typeof body.refresh_token === 'string' ? body.refresh_token : undefined,
    scope: typeof body.scope === 'string' ? body.scope : undefined,
    expiresIn: typeof body.expires_in === 'number' ? body.expires_in : undefined,
  };
}

export interface AccessToken {
  accessToken: string;
  expiresIn: number;
  /** Google may rotate the refresh token; when present it replaces the stored one. */
  refreshToken?: string;
}

/**
 * Gets a fresh access token from a stored refresh token. Throws GoogleOAuthError('invalid_grant')
 * when access was revoked or expired (the account then needs reconnecting).
 */
export async function refreshAccessToken(
  config: Pick<GoogleClientConfig, 'clientId' | 'clientSecret'>,
  refreshToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<AccessToken> {
  const response = await fetchImpl(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
    signal: AbortSignal.timeout(10_000),
  });
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    throw new GoogleOAuthError(typeof body.error === 'string' ? body.error : `http_${response.status}`);
  }
  if (typeof body.access_token !== 'string') throw new GoogleOAuthError('malformed_token_response');
  return {
    accessToken: body.access_token,
    expiresIn: typeof body.expires_in === 'number' ? body.expires_in : 3600,
    refreshToken: typeof body.refresh_token === 'string' ? body.refresh_token : undefined,
  };
}

/**
 * Revokes a token at Google. Revoking a refresh token removes the app's whole grant for that
 * account. A 400 means it was already invalid, which counts as success.
 */
export async function revokeToken(token: string, fetchImpl: typeof fetch = fetch): Promise<void> {
  const response = await fetchImpl(REVOKE_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok && response.status !== 400) throw new GoogleOAuthError(`revoke_http_${response.status}`);
}

export interface GoogleIdentity {
  subject: string;
  email: string;
  emailVerified: boolean;
  name: string | null;
}

/** Verifies signature, issuer, audience, expiry and nonce of a Google ID token. */
export async function verifyIdToken(
  idToken: string,
  options: { clientId: string; nonce: string; keys?: JWTVerifyGetKey },
): Promise<GoogleIdentity> {
  const { payload } = await jwtVerify(idToken, options.keys ?? googleKeys, {
    issuer: GOOGLE_ISSUERS,
    audience: options.clientId,
    algorithms: ['RS256'],
  });
  if (payload.nonce !== options.nonce) throw new GoogleOAuthError('nonce_mismatch');
  if (typeof payload.sub !== 'string' || typeof payload.email !== 'string') {
    throw new GoogleOAuthError('missing_claims');
  }
  return {
    subject: payload.sub,
    email: payload.email,
    emailVerified: payload.email_verified === true,
    name: typeof payload.name === 'string' ? payload.name : null,
  };
}
