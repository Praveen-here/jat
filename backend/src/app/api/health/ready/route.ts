import { checkDatabase } from '@/server/db/pool';
import { apiRoute } from '@/server/http/api-route';
import { getRuntime } from '@/server/runtime';

export const dynamic = 'force-dynamic';

/** Readiness: the backend can reach the database. */
export const GET = apiRoute('GET /api/health/ready', async () => {
  const { pool, logger } = getRuntime();
  try {
    await checkDatabase(pool);
    return Response.json({ status: 'ok', database: 'ok' });
  } catch (err) {
    logger.warn({ err }, 'database health check failed');
    return Response.json({ status: 'degraded', database: 'unreachable' }, { status: 503 });
  }
});
