import type { Kysely } from 'kysely';
import type pg from 'pg';
import { loadEnv, type Env } from './config/env';
import { createDb, createPool, type Database } from './db/pool';
import { createLogger, type Logger } from './lib/logger';

/** Process-wide singletons for API routes: config, logger, database. */
export interface Runtime {
  env: Env;
  logger: Logger;
  pool: pg.Pool;
  db: Kysely<Database>;
}

// Kept on globalThis so Next.js hot reload in development doesn't open a new pool per edit.
const holder = globalThis as typeof globalThis & { __trackerRuntime?: Runtime };

export function getRuntime(): Runtime {
  if (!holder.__trackerRuntime) {
    const env = loadEnv();
    const logger = createLogger({ level: env.LOG_LEVEL, service: 'backend', pretty: env.NODE_ENV === 'development' });
    const pool = createPool(env.DATABASE_URL, logger);
    holder.__trackerRuntime = { env, logger, pool, db: createDb(pool) };
  }
  return holder.__trackerRuntime;
}
