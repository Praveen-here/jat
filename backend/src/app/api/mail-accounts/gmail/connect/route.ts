import { authSettings, currentUser, googleClient, MAILBOX_CALLBACK_PATH } from '@/server/auth/context';
import { serializeCookie } from '@/server/auth/cookies';
import { pkceChallenge } from '@/server/auth/crypto';
import { buildAuthorizationUrl, GMAIL_CONNECT_SCOPES } from '@/server/auth/google';
import { OAUTH_FLOW_TTL_SECONDS, startOAuthFlow } from '@/server/auth/oauth-flows';
import { apiRoute, jsonError } from '@/server/http/api-route';
import { isSameOrigin, redirectTo } from '@/server/http/responses';
import { countMailAccounts, MAX_MAIL_ACCOUNTS_PER_USER } from '@/server/mail-accounts/accounts';
import { getRuntime } from '@/server/runtime';

export const dynamic = 'force-dynamic';

/**
 * Starts connecting a Gmail mailbox (a form POST from the app): sends the browser to Google's
 * consent screen for read-only Gmail. `prompt=consent` + `access_type=offline` make Google
 * issue a refresh token, which background sync needs.
 */
export const POST = apiRoute('POST /api/mail-accounts/gmail/connect', async (request) => {
  const { db, env } = getRuntime();
  const { appUrl, secure, cookies } = authSettings(env);
  if (!isSameOrigin(request, appUrl)) return jsonError(403, 'FORBIDDEN', 'Cross-site request blocked.');

  const user = await currentUser(request);
  if (!user) return redirectTo(`${appUrl}/`, [], 303);
  if ((await countMailAccounts(db, user.id)) >= MAX_MAIL_ACCOUNTS_PER_USER) {
    return redirectTo(`${appUrl}/app/settings?connect=limit_reached`, [], 303);
  }

  const google = googleClient(env, MAILBOX_CALLBACK_PATH);
  const flow = await startOAuthFlow(db, 'connect', user.id);
  const authorizationUrl = buildAuthorizationUrl(google, {
    scopes: GMAIL_CONNECT_SCOPES,
    state: flow.state,
    nonce: flow.nonce,
    codeChallenge: pkceChallenge(flow.codeVerifier),
    prompt: 'consent',
    accessType: 'offline',
  });

  return redirectTo(
    authorizationUrl,
    [serializeCookie(cookies.oauthBinding, flow.bindingToken, { secure, maxAgeSeconds: OAUTH_FLOW_TTL_SECONDS })],
    303,
  );
});
