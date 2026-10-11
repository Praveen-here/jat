import { currentUser, tokenEncryptionKey } from '@/server/auth/context';
import { deriveContentKey } from '@/server/crypto/content';
import { apiRoute, jsonError } from '@/server/http/api-route';
import { listJobEmails } from '@/server/job-emails/list';
import { getRuntime } from '@/server/runtime';

export const dynamic = 'force-dynamic';

/** Job-related emails detected so far (newest first). ?view=review for those needing a check. */
export const GET = apiRoute('GET /api/job-emails', async (request) => {
  const user = await currentUser(request);
  if (!user) return jsonError(401, 'UNAUTHENTICATED', 'Please sign in.');
  const { db, env } = getRuntime();
  const view = new URL(request.url).searchParams.get('view') === 'review' ? 'review' : 'all';
  const result = await listJobEmails(db, deriveContentKey(tokenEncryptionKey(env)), user.id, { view });
  return Response.json(result);
});
