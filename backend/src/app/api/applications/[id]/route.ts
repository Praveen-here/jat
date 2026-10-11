import { z } from 'zod';
import { currentUser, tokenEncryptionKey } from '@/server/auth/context';
import { getApplication } from '@/server/applications/queries';
import { deriveContentKey } from '@/server/crypto/content';
import { apiRoute, jsonError } from '@/server/http/api-route';
import { getRuntime } from '@/server/runtime';

export const dynamic = 'force-dynamic';

const Params = z.object({ id: z.uuid() });

/** One application and its email timeline. Someone else's application is a plain 404. */
export const GET = apiRoute<{ params: Promise<{ id: string }> }>('GET /api/applications/:id', async (request, context) => {
  const user = await currentUser(request);
  if (!user) return jsonError(401, 'UNAUTHENTICATED', 'Please sign in.');
  const parsed = Params.safeParse(await context.params);
  if (!parsed.success) return jsonError(404, 'NOT_FOUND', 'Application not found.');
  const { db, env } = getRuntime();
  const result = await getApplication(db, deriveContentKey(tokenEncryptionKey(env)), user.id, parsed.data.id);
  return result ? Response.json(result) : jsonError(404, 'NOT_FOUND', 'Application not found.');
});
