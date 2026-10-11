import { PgBoss, type Queue } from 'pg-boss';
import type { Logger } from '../lib/logger';

/** pg-boss keeps its own tables in a separate schema, next to `app`. */
export const JOBS_SCHEMA = 'pgboss';

/**
 * Queue names. Job payloads carry IDs only, never email content, because job rows are
 * stored in the database and may appear in error reports.
 */
export const QUEUES = {
  heartbeat: 'system-heartbeat',
  cleanup: 'maintenance-cleanup',
  syncTick: 'sync-scheduler-tick',
  accountSync: 'account-sync',
} as const;

export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

/**
 * account-sync is "stately" with the account id as singletonKey: at most one queued and one
 * active job per mailbox, so repeated triggers collapse instead of piling up. The sync lease
 * (sync/lease.ts) is the real guarantee; this just avoids wasted jobs.
 */
const QUEUE_OPTIONS: Partial<Record<QueueName, Omit<Queue, 'name'>>> = {
  [QUEUES.accountSync]: { policy: 'stately', retryLimit: 0, expireInSeconds: 15 * 60 },
  [QUEUES.syncTick]: { policy: 'singleton', retryLimit: 0 },
};

export function createBoss(connectionString: string, logger: Logger): PgBoss {
  const boss = new PgBoss({ connectionString, schema: JOBS_SCHEMA });
  boss.on('error', (err) => logger.error({ err }, 'job queue error'));
  return boss;
}

/** Creates each queue once; safe to call on every start. */
export async function ensureQueues(boss: PgBoss, names: readonly QueueName[]): Promise<void> {
  for (const name of names) {
    if (!(await boss.getQueue(name))) await boss.createQueue(name, QUEUE_OPTIONS[name]);
  }
}
