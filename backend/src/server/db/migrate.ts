import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type pg from 'pg';
import type { Logger } from '../lib/logger';

/**
 * Minimal forward-only migration runner.
 *
 * - Files are `NNNN_description.sql`, applied in order, each inside its own transaction.
 * - A session advisory lock stops two processes migrating at the same time.
 * - Applied files are checksummed; editing an applied migration is an error. Write a new one.
 */
const MIGRATION_FILE = /^(\d{4})_([a-z0-9_]+)\.sql$/;
const MIGRATION_LOCK_KEY = 72_730_001;

export interface Migration {
  version: string;
  name: string;
  sql: string;
  checksum: string;
}

export async function loadMigrations(dir: string): Promise<Migration[]> {
  const files = (await readdir(dir)).filter((file) => MIGRATION_FILE.test(file)).sort();
  const migrations: Migration[] = [];
  for (const file of files) {
    const [, version, name] = MIGRATION_FILE.exec(file) as RegExpExecArray;
    const sql = await readFile(join(dir, file), 'utf8');
    // Normalise line endings so a Windows checkout and a Linux CI produce the same checksum.
    const checksum = createHash('sha256').update(sql.replace(/\r\n/g, '\n')).digest('hex');
    migrations.push({ version: version!, name: name!, sql, checksum });
  }
  if (new Set(migrations.map((m) => m.version)).size !== migrations.length) {
    throw new Error('Two migration files share the same version number');
  }
  return migrations;
}

export async function migrate(pool: pg.Pool, dir: string, logger: Logger): Promise<string[]> {
  const migrations = await loadMigrations(dir);
  const client = await pool.connect();
  const appliedNow: string[] = [];
  try {
    await client.query('select pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
    await client.query('create schema if not exists app');
    await client.query(`
      create table if not exists app.schema_migrations (
        version    text primary key,
        name       text not null,
        checksum   text not null,
        applied_at timestamptz not null default now()
      )`);

    const { rows } = await client.query<{ version: string; checksum: string }>(
      'select version, checksum from app.schema_migrations',
    );
    const applied = new Map(rows.map((row) => [row.version, row.checksum]));

    for (const migration of migrations) {
      const label = `${migration.version}_${migration.name}`;
      const previousChecksum = applied.get(migration.version);
      if (previousChecksum) {
        if (previousChecksum !== migration.checksum) {
          throw new Error(`Migration ${label} was changed after it was applied. Add a new migration instead.`);
        }
        continue;
      }
      await client.query('begin');
      try {
        await client.query(migration.sql);
        await client.query('insert into app.schema_migrations (version, name, checksum) values ($1, $2, $3)', [
          migration.version,
          migration.name,
          migration.checksum,
        ]);
        await client.query('commit');
      } catch (err) {
        await client.query('rollback');
        throw err;
      }
      appliedNow.push(label);
      logger.info({ migration: label }, 'migration applied');
    }
    return appliedNow;
  } finally {
    await client.query('select pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]).catch(() => undefined);
    client.release();
  }
}
