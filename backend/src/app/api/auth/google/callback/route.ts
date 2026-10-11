import { authSettings, googleClient, LOGIN_CALLBACK_PATH } from '@/server/auth/context';
import { clearCookie, readCookie, serializeCookie } from '@/server/auth/cookies';
import { exchangeCode, GoogleOAuthError, verifyIdToken, type GoogleIdentity } from '@/server/auth/google';
import { consumeOAuthFlow } from '@/server/auth/oauth-flows';
import { createSession, SESSION_ABSOLUTE_MS } from '@/server/auth/sessions';
import { upsertGoogleUser } from '@/server/auth/users';
import { apiRoute } from '@/server/http/api-route';
import { redirectTo } from '@/server/http/responses';
import { getRuntime } from '@/server/runtime';

export const dynamic = 'force-dynamic';

/**
 * Step 2 of sign-in: Google redirects back here with ?code&state.
 * Checks the flow (single use, unexpired, same browser), exchanges the code with PKCE,
 * verifies the ID token, then creates the user (first time) and a session.
 * Google's access token is discarded: sign-in needs nothing stored from Google.
 */
export const GET = apiRoute('GET /api/auth/google/callback', async (request) => {
  const { db, env, logger } = getRuntime();
  const { appUrl, secure, cookies } = authSettings(env);
  const params = new URL(request.url).searchParams;
  const clearBinding = clearCookie(cookies.oauthBinding, secure);
  const fail = (reason: 'denied' | 'expired' | 'failed' | 'unverified_email') =>
    redirectTo(`${appUrl}/?auth_error=${reason}`, [clearBinding]);

  const googleError = params.get('error');
  if (googleError) return fail(googleError === 'access_denied' ? 'denied' : 'failed');

  const code = params.get('code');
  const state = params.get('state');
  if (!code || !state) return fail('failed');

  const flow = await consumeOAuthFlow(db, {
    state,
    purpose: 'login',
    bindingToken: readCookie(request, cookies.oauthBinding),
  });
  if (!flow) return fail('expired');

  const google = googleClient(env, LOGIN_CALLBACK_PATH);
  let identity: GoogleIdentity;
  try {
    const tokens = await exchangeCode(google, code, flow.codeVerifier);
    identity = await verifyIdToken(tokens.idToken, { clientId: google.clientId, nonce: flow.nonce });
  } catch (err) {
    logger.warn({ err, errorCode: err instanceof GoogleOAuthError ? err.code : 'verify_failed' }, 'google sign-in failed');
    return fail('failed');
  }
  if (!identity.emailVerified) return fail('unverified_email');

  const user = await upsertGoogleUser(db, identity);
  const session = await createSession(db, user.id);
  logger.info({ userId: user.id }, 'user signed in');

  return redirectTo(`${appUrl}/app`, [
    clearBinding,
    serializeCookie(cookies.session, session.token, { secure, maxAgeSeconds: SESSION_ABSOLUTE_MS / 1000 }),
  ]);
});
