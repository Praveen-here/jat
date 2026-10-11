import { describe, expect, it } from 'vitest';
import { fullJitterDelay, withRetry } from '../lib/retry';
import { syncIntervalMs } from './engine';
import { TokenBucket } from './rate-limiter';

describe('TokenBucket', () => {
  it('lets a burst through, then makes callers wait for refill', async () => {
    let now = 0;
    const waits: number[] = [];
    const bucket = new TokenBucket(100, 10, () => now, async (ms) => {
      waits.push(ms);
      now += ms;
    });

    await bucket.take(60);
    await bucket.take(40);
    expect(waits).toEqual([]);
    await bucket.take(20); // empty: needs 2 seconds at 10 units/second
    expect(waits).toEqual([2000]);
  });

  it('keeps a mailbox under 4,500 units a minute however hard it is pushed', async () => {
    let now = 0;
    const bucket = new TokenBucket(1000, 75, () => now, async (ms) => {
      now += ms;
    });
    let units = 0;
    while (now < 10 * 60_000) {
      await bucket.take(20);
      units += 20;
    }
    // 10 minutes: at most the burst plus 75 units/second.
    expect(units).toBeLessThanOrEqual(1000 + 75 * 600 + 20);
    expect(units / 10).toBeLessThan(6000); // Gmail's per-user limit per minute
  });
});

describe('retry', () => {
  it('uses full jitter: a random wait between 0 and the capped exponential delay', () => {
    expect(fullJitterDelay(0, 1000, 60_000, () => 1)).toBe(1000);
    expect(fullJitterDelay(3, 1000, 60_000, () => 1)).toBe(8000);
    expect(fullJitterDelay(10, 1000, 60_000, () => 1)).toBe(60_000);
    expect(fullJitterDelay(10, 1000, 60_000, () => 0)).toBe(0);
  });

  it('retries only retryable errors, up to the attempt limit', async () => {
    let calls = 0;
    const options = { attempts: 3, baseMs: 1, capMs: 1, sleep: async () => undefined, isRetryable: (e: unknown) => e === 'retry' };
    await expect(
      withRetry(async () => {
        calls++;
        throw 'retry';
      }, options),
    ).rejects.toBe('retry');
    expect(calls).toBe(3);

    calls = 0;
    await expect(
      withRetry(async () => {
        calls++;
        throw 'fatal';
      }, options),
    ).rejects.toBe('fatal');
    expect(calls).toBe(1);
  });
});

describe('sync interval', () => {
  const now = new Date('2026-10-11T00:00:00Z');
  const ago = (days: number) => new Date(now.getTime() - days * 24 * 3600 * 1000);

  it('syncs often for active users and rarely for inactive ones', () => {
    expect(syncIntervalMs(ago(1), now)).toBe(10 * 60_000);
    expect(syncIntervalMs(ago(20), now)).toBe(60 * 60_000);
    expect(syncIntervalMs(ago(60), now)).toBe(12 * 60 * 60_000);
    expect(syncIntervalMs(null, now)).toBe(12 * 60 * 60_000);
  });
});
