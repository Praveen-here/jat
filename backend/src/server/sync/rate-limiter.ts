import { sleep as realSleep } from '../lib/retry';

/**
 * Keeps each mailbox under Gmail's per-user quota (6,000 units/minute, docs/plan §6.1).
 * We budget 75% of it: 4,500 units/minute = 75 units/second, bursting up to one batch.
 *
 * Token bucket: the bucket refills continuously; each API call takes its cost in units and
 * waits if the bucket is short. In memory: correct while one worker process syncs a mailbox,
 * which the sync lease guarantees.
 */
export const GMAIL_UNITS_PER_SECOND = 75;
export const GMAIL_BURST_UNITS = 1_000;

export class TokenBucket {
  private tokens: number;
  private refilledAt: number;

  constructor(
    private readonly capacity: number,
    private readonly refillPerSecond: number,
    private readonly now: () => number = Date.now,
    private readonly sleep: (ms: number) => Promise<void> = realSleep,
  ) {
    this.tokens = capacity;
    this.refilledAt = now();
  }

  private refill(): void {
    const now = this.now();
    this.tokens = Math.min(this.capacity, this.tokens + ((now - this.refilledAt) / 1000) * this.refillPerSecond);
    this.refilledAt = now;
  }

  async take(units: number): Promise<void> {
    if (units > this.capacity) throw new Error(`Cannot take ${units} units from a bucket of ${this.capacity}`);
    for (;;) {
      this.refill();
      if (this.tokens >= units) {
        this.tokens -= units;
        return;
      }
      await this.sleep(Math.ceil(((units - this.tokens) / this.refillPerSecond) * 1000));
    }
  }
}

/** One bucket per mailbox. */
export class RateLimiters {
  private readonly buckets = new Map<string, TokenBucket>();

  constructor(private readonly create: () => TokenBucket = () => new TokenBucket(GMAIL_BURST_UNITS, GMAIL_UNITS_PER_SECOND)) {}

  forAccount(accountId: string): TokenBucket {
    let bucket = this.buckets.get(accountId);
    if (!bucket) {
      bucket = this.create();
      this.buckets.set(accountId, bucket);
    }
    return bucket;
  }
}
