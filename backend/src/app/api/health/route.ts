import { apiRoute } from '@/server/http/api-route';

export const dynamic = 'force-dynamic';

/** Liveness: the backend process is up. Does not touch the database. */
export const GET = apiRoute('GET /api/health', async () => Response.json({ status: 'ok' }));
