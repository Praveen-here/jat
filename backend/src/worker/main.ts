import { hostname } from 'node:os';
import { googleCredentials, hmacPepper, tokenEncryptionKey } from '../server/auth/context';
import { loadEnv } from '../server/config/env';
import { createDb, createPool } from '../server/db/pool';
import { createBoss, ensureQueues, QUEUES } from '../server/jobs/boss';
import { cleanupExpiredAuthData } from '../server/jobs/cleanup';
import { deriveContentKey } from '../server/crypto/content';
import { createAiClassifier } from '../server/ai/classify-ai';
import { GroqClient } from '../server/ai/groq';
import { createLogger } from '../server/lib/logger';
import { syncAccount } from '../server/sync/engine';
import { GmailAccess } from '../server/sync/gmail-access';
import { RateLimiters } from '../server/sync/rate-limiter';
import { ensureMissingSyncStates, findDueAccounts } from '../server/sync/schedule';

/**
 * Background worker: a separate long-running process (Next.js can't run timed jobs).
 *
 *   every minute  sync-scheduler-tick → queue account-sync for each mailbox that is due
 *   account-sync  one bounded slice of Gmail sync for one mailbox (sync/engine.ts)
 *   hourly        cleanup of expired sign-in data
 */
const env = loadEnv();
const logger = createLogger({ level: env.LOG_LEVEL, service: 'worker', pretty: env.NODE_ENV === 'development' });
const pool = createPool(env.DATABASE_URL, logger);
const db = createDb(pool);
const boss = createBoss(env.DATABASE_URL, logger);
const workerId = `${hostname()}:${process.pid}`;

const kek = tokenEncryptionKey(env);
const gmail = new GmailAccess(db, kek, googleCredentials(env), new RateLimiters());
const syncDeps = {
  db,
  logger,
  workerId,
  pepper: hmacPepper(env),
  contentKey: deriveContentKey(kek),
  ai: env.AI_ENABLED && env.GROQ_API_KEY ? createAiClassifier(new GroqClient({ apiKey: env.GROQ_API_KEY, model: env.GROQ_MODEL })) : null,
  providerFor: (account: { id: string }) => gmail.providerFor(account),
};

await boss.start();
await ensureQueues(boss, Object.values(QUEUES));

await boss.schedule(QUEUES.heartbeat, '*/5 * * * *');
await boss.work(QUEUES.heartbeat, async ([job]) => {
  logger.info({ jobId: job?.id, queue: QUEUES.heartbeat }, 'worker heartbeat');
});

await boss.schedule(QUEUES.cleanup, '17 * * * *');
await boss.work(QUEUES.cleanup, async ([job]) => {
  const deleted = await cleanupExpiredAuthData(db);
  logger.info({ jobId: job?.id, queue: QUEUES.cleanup, ...deleted }, 'expired auth data cleaned up');
});

await boss.schedule(QUEUES.syncTick, '* * * * *');
await boss.work(QUEUES.syncTick, async () => {
  const created = await ensureMissingSyncStates(db);
  if (created > 0) logger.info({ count: created }, 'created missing sync states');
  for (const accountId of await findDueAccounts(db)) {
    await boss.send(QUEUES.accountSync, { accountId }, { singletonKey: accountId });
  }
});

await boss.work<{ accountId: string }>(QUEUES.accountSync, { localConcurrency: 4 }, async ([job]) => {
  if (!job) return;
  const outcome = await syncAccount(syncDeps, job.data.accountId);
  // Work left (big import): queue the next slice right away instead of waiting for the tick.
  if (outcome === 'more_work') {
    await boss.send(QUEUES.accountSync, { accountId: job.data.accountId }, { singletonKey: job.data.accountId });
  }
});

logger.info({ status: 'ready', phase: syncDeps.ai ? 'ai_on' : 'rules_only' }, 'worker started');

let stopping = false;
async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  logger.info({ phase: signal }, 'worker stopping');
  await boss.stop({ graceful: true, timeout: 30_000 });
  await pool.end();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
