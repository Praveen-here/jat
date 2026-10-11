import { z } from 'zod';
import { authSettings, currentUser, tokenEncryptionKey } from '@/server/auth/context';
import { revokeToken } from '@/server/auth/google';
import { apiRoute, jsonError } from '@/server/http/api-route';
import { isSameOrigin, redirectTo } from '@/server/http/responses';
import { disconnectMailAccount } from '@/server/mail-accounts/accounts';
import { getRuntime } from '@/server/runtime';

export const dynamic = 'force-dynamic';

const Params = z.object({ id: z.uuid() });

/** Disconnects a mailbox: deletes everything stored for it and revokes Google's access. */
export const POST = apiRoute<{ params: Promise<{ id: string }> }>(
  'POST /api/mail-accounts/:id/disconnect',
  async (request, context) => {
    const { db, env, logger } = getRuntime();
    const { appUrl } = authSettings(env);
    if (!isSameOrigin(request, appUrl)) return jsonError(403, 'FORBIDDEN', 'Cross-site request blocked.');

    const user = await currentUser(request);
    if (!user) return redirectTo(`${appUrl}/`, [], 303);

    const parsed = Params.safeParse(await context.params);
    if (!parsed.success) return redirectTo(`${appUrl}/app/settings?disconnect=not_found`, [], 303);

    const result = await disconnectMailAccount(db, tokenEncryptionKey(env), {
      userId: user.id,
      mailAccountId: parsed.data.id,
      revoke: (token) => revokeToken(token),
    });
    if (!result.ok) return redirectTo(`${appUrl}/app/settings?disconnect=not_found`, [], 303);

    logger.info({ userId: user.id, accountId: parsed.data.id, status: result.revoked ? 'revoked' : 'revoke_failed' }, 'gmail disconnected');
    return redirectTo(`${appUrl}/app/settings?disconnect=${result.revoked ? 'done' : 'done_not_revoked'}`, [], 303);
  },
);
