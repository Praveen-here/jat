import { fileURLToPath } from 'node:url';
import type { Kysely } from 'kysely';
import pg from 'pg';
import { migrate } from '../db/migrate';
import { createDb, type Database } from '../db/pool';
import { createLogger } from '../lib/logger';

/**
 * Database tests run against TEST_DATABASE_URL, a separate throwaway database, never the
 * development one. Use `describe.skipIf(!TEST_DATABASE_URL)` so tests skip when it's unset.
 */
export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

const MIGRATIONS_DIR = fileURLToPath(new URL('../../../migrations', import.meta.url));

export interface TestDb {
  pool: pg.Pool;
  db: Kysely<Database>;
  reset: () => Promise<void>;
  close: () => Promise<void>;
}

export async function setupTestDb(): Promise<TestDb> {
  if (!TEST_DATABASE_URL) throw new Error('TEST_DATABASE_URL is not set');
  const pool = new pg.Pool({ connectionString: TEST_DATABASE_URL, max: 4 });
  await migrate(pool, MIGRATIONS_DIR, createLogger({ level: 'silent', service: 'test' }));
  const db = createDb(pool);
  return {
    pool,
    db,
    reset: async () => {
      await pool.query('truncate app.oauth_flows, app.sessions, app.auth_identities, app.users cascade');
    },
    close: async () => {
      await db.destroy();
    },
  };
}
