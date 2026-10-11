import { currentUser } from '@/server/auth/context';
import { apiRoute, jsonError } from '@/server/http/api-route';

export const dynamic = 'force-dynamic';

/** The signed-in user, or 401. */
export const GET = apiRoute('GET /api/me', async (request) => {
  const user = await currentUser(request);
  if (!user) return jsonError(401, 'UNAUTHENTICATED', 'Please sign in.');
  return Response.json({ user: { id: user.id, email: user.email, name: user.displayName } });
});
