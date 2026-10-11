import {
  authSettings,
  currentUser,
  googleClient,
  MAILBOX_CALLBACK_PATH,
  tokenEncryptionKey,
} from '@/server/auth/context';
import { clearCookie, readCookie } from '@/server/auth/cookies';
import {
  exchangeCode,
  GMAIL_READONLY_SCOPE,
  GoogleOAuthError,
  hasGrantedScope,
  verifyIdToken,
  type GoogleIdentity,
  type TokenResponse,
} from '@/server/auth/google';
import { consumeOAuthFlow } from '@/server/auth/oauth-flows';
import { getProfile, GmailApiError } from '@/server/gmail/client';
import { apiRoute } from '@/server/http/api-route';
import { redirectTo } from '@/server/http/responses';
import { linkGmailAccount } from '@/server/mail-accounts/accounts';
import { getRuntime } from '@/server/runtime';
import { ensureSyncState } from '@/server/sync/engine';

export const dynamic = 'force-dynamic';

type ConnectOutcome =
  | 'connected'
  | 'reconnected'
  | 'denied'
  | 'expired'
  | 'scope_missing'
  | 'no_refresh_token'
  | 'linked_elsewhere'
  | 'limit_reached'
  | 'gmail_api_disabled'
  | 'failed';

/**
 * Google returns here after the Gmail consent screen. Checks, in order: the flow (single use,
 * same browser, same signed-in user), that Gmail read access was actually granted, that a
 * refresh token was issued, which Google account it is, and that Gmail answers. Then stores
 * the refresh token encrypted. The short-lived access token is not stored.
 */
export const GET = apiRoute('GET /api/auth/google/mailbox/callback', async (request) => {
  const { db, env, logger } = getRuntime();
  const { appUrl, secure, cookies } = authSettings(env);
  const params = new URL(request.url).searchParams;
  const clearBinding = clearCookie(cookies.oauthBinding, secure);
  const finish = (outcome: ConnectOutcome) =>
    redirectTo(`${appUrl}/app/settings?connect=${outcome}`, [clearBinding]);

  const user = await currentUser(request);
  if (!user) return redirectTo(`${appUrl}/?auth_error=expired`, [clearBinding]);

  const googleError = params.get('error');
  if (googleError) return finish(googleError === 'access_denied' ? 'denied' : 'failed');

  const code = params.get('code');
  const state = params.get('state');
  if (!code || !state) return finish('failed');

  const flow = await consumeOAuthFlow(db, {
    state,
    purpose: 'connect',
    bindingToken: readCookie(request, cookies.oauthBinding),
  });
  // The flow must have been started by the user who is signed in now.
  if (!flow || flow.userId !== user.id) return finish('expired');

  const google = googleClient(env, MAILBOX_CALLBACK_PATH);
  let tokens: TokenResponse;
  let identity: GoogleIdentity;
  try {
    tokens = await exchangeCode(google, code, flow.codeVerifier);
    identity = await verifyIdToken(tokens.idToken, { clientId: google.clientId, nonce: flow.nonce });
  } catch (err) {
    logger.warn(
      { err, userId: user.id, errorCode: err instanceof GoogleOAuthError ? err.code : 'verify_failed' },
      'gmail connect: token exchange failed',
    );
    return finish('failed');
  }

  if (!hasGrantedScope(tokens.scope, GMAIL_READONLY_SCOPE)) return finish('scope_missing');
  if (!tokens.refreshToken) return finish('no_refresh_token');

  let address: string;
  try {
    address = (await getProfile(tokens.accessToken)).emailAddress;
  } catch (err) {
    if (err instanceof GmailApiError && err.isApiDisabled) return finish('gmail_api_disabled');
    logger.warn({ err, userId: user.id }, 'gmail connect: profile check failed');
    return finish('failed');
  }

  const result = await linkGmailAccount(db, tokenEncryptionKey(env), {
    userId: user.id,
    providerSubject: identity.subject,
    address,
    grantedScopes: (tokens.scope ?? '').split(' ').filter(Boolean),
    refreshToken: tokens.refreshToken,
  });
  if (!result.ok) return finish(result.reason);

  // The worker's next scheduler tick (within a minute) starts the import, or, after a
  // reconnect, catches up on anything missed while access was broken.
  await ensureSyncState(db, result.accountId);

  logger.info({ userId: user.id, accountId: result.accountId, status: result.reconnected ? 'reconnected' : 'connected' }, 'gmail connected');
  return finish(result.reconnected ? 'reconnected' : 'connected');
});
