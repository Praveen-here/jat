import { currentUser } from '@/server/auth/context';
import { apiRoute, jsonError } from '@/server/http/api-route';
import { listMailAccounts, MAX_MAIL_ACCOUNTS_PER_USER } from '@/server/mail-accounts/accounts';
import { getRuntime } from '@/server/runtime';
import { syncSummaries } from '@/server/sync/status';

export const dynamic = 'force-dynamic';

/** The signed-in user's connected mailboxes, with sync progress. */
export const GET = apiRoute('GET /api/mail-accounts', async (request) => {
  const user = await currentUser(request);
  if (!user) return jsonError(401, 'UNAUTHENTICATED', 'Please sign in.');
  const { db } = getRuntime();
  const [accounts, summaries] = await Promise.all([listMailAccounts(db, user.id), syncSummaries(db, user.id)]);
  return Response.json({
    accounts: accounts.map((account) => ({ ...account, sync: summaries.get(account.id) ?? null })),
    limit: MAX_MAIL_ACCOUNTS_PER_USER,
  });
});
