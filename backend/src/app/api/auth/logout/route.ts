import { authSettings } from '@/server/auth/context';
import { clearCookie, readCookie } from '@/server/auth/cookies';
import { revokeSession } from '@/server/auth/sessions';
import { apiRoute, jsonError } from '@/server/http/api-route';
import { isSameOrigin, redirectTo } from '@/server/http/responses';
import { getRuntime } from '@/server/runtime';

export const dynamic = 'force-dynamic';

/** Signs out: revokes the session server-side (the cookie becomes useless) and clears it. */
export const POST = apiRoute('POST /api/auth/logout', async (request) => {
  const { db, env } = getRuntime();
  const { appUrl, secure, cookies } = authSettings(env);
  if (!isSameOrigin(request, appUrl)) return jsonError(403, 'FORBIDDEN', 'Cross-site request blocked.');

  await revokeSession(db, readCookie(request, cookies.session));
  return redirectTo(`${appUrl}/`, [clearCookie(cookies.session, secure)], 303);
});
