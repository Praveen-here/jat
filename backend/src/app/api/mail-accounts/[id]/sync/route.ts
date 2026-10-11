import { z } from 'zod';
import { authSettings, currentUser } from '@/server/auth/context';
import { apiRoute, jsonError } from '@/server/http/api-route';
import { isSameOrigin, redirectTo } from '@/server/http/responses';
import { getRuntime } from '@/server/runtime';
import { requestSyncNow } from '@/server/sync/schedule';

export const dynamic = 'force-dynamic';

const Params = z.object({ id: z.uuid() });

/** "Sync now": the worker picks the mailbox up within a minute. */
export const POST = apiRoute<{ params: Promise<{ id: string }> }>(
  'POST /api/mail-accounts/:id/sync',
  async (request, context) => {
    const { db, env } = getRuntime();
    const { appUrl } = authSettings(env);
    if (!isSameOrigin(request, appUrl)) return jsonError(403, 'FORBIDDEN', 'Cross-site request blocked.');

    const user = await currentUser(request);
    if (!user) return redirectTo(`${appUrl}/`, [], 303);

    const parsed = Params.safeParse(await context.params);
    const result = parsed.success ? await requestSyncNow(db, user.id, parsed.data.id) : 'not_found';
    return redirectTo(`${appUrl}/app/settings?sync=${result}`, [], 303);
  },
);
