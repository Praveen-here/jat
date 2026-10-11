import { authSettings, googleClient, LOGIN_CALLBACK_PATH } from '@/server/auth/context';
import { serializeCookie } from '@/server/auth/cookies';
import { pkceChallenge } from '@/server/auth/crypto';
import { buildAuthorizationUrl, LOGIN_SCOPES } from '@/server/auth/google';
import { OAUTH_FLOW_TTL_SECONDS, startOAuthFlow } from '@/server/auth/oauth-flows';
import { apiRoute } from '@/server/http/api-route';
import { redirectTo } from '@/server/http/responses';
import { getRuntime } from '@/server/runtime';

export const dynamic = 'force-dynamic';

/** Step 1 of sign-in: send the browser to Google's account chooser. Identity scopes only. */
export const GET = apiRoute('GET /api/auth/google/login', async () => {
  const { db, env } = getRuntime();
  const { secure, cookies } = authSettings(env);
  const google = googleClient(env, LOGIN_CALLBACK_PATH);

  const flow = await startOAuthFlow(db, 'login');
  const authorizationUrl = buildAuthorizationUrl(google, {
    scopes: LOGIN_SCOPES,
    state: flow.state,
    nonce: flow.nonce,
    codeChallenge: pkceChallenge(flow.codeVerifier),
    prompt: 'select_account',
  });

  return redirectTo(authorizationUrl, [
    serializeCookie(cookies.oauthBinding, flow.bindingToken, { secure, maxAgeSeconds: OAUTH_FLOW_TTL_SECONDS }),
  ]);
});
