import { currentUser } from '@/server/auth/context';
import { listApplications } from '@/server/applications/queries';
import { apiRoute, jsonError } from '@/server/http/api-route';
import { getRuntime } from '@/server/runtime';

export const dynamic = 'force-dynamic';

/** The signed-in user's applications, most recently active first. ?view=review for those to check. */
export const GET = apiRoute('GET /api/applications', async (request) => {
  const user = await currentUser(request);
  if (!user) return jsonError(401, 'UNAUTHENTICATED', 'Please sign in.');
  const view = new URL(request.url).searchParams.get('view') === 'review' ? 'review' : 'all';
  return Response.json(await listApplications(getRuntime().db, user.id, view));
});
