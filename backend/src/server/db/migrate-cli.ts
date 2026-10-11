import { fileURLToPath } from 'node:url';
import { loadEnv } from '../config/env';
import { createLogger } from '../lib/logger';
import { migrate } from './migrate';
import { createPool } from './pool';

const MIGRATIONS_DIR = fileURLToPath(new URL('../../../migrations', import.meta.url));

const env = loadEnv();
const logger = createLogger({ level: env.LOG_LEVEL, service: 'migrate', pretty: env.NODE_ENV === 'development' });
const pool = createPool(env.DATABASE_URL, logger);

try {
  const applied = await migrate(pool, MIGRATIONS_DIR, logger);
  logger.info({ count: applied.length }, applied.length ? 'migrations complete' : 'database already up to date');
} catch (err) {
  logger.fatal({ err }, 'migration failed');
  process.exitCode = 1;
} finally {
  await pool.end();
}
