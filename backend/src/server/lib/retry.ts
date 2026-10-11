/**
 * Retries with exponential backoff and "full jitter": each wait is a random time between 0 and
 * min(cap, base * 2^attempt). Randomness spreads retries out, so many clients that failed together
 * don't all retry at the same instant.
 */
export interface RetryOptions {
  /** Total tries, including the first. */
  attempts: number;
  baseMs: number;
  capMs: number;
  isRetryable: (err: unknown) => boolean;
  /** Server-requested wait (e.g. Retry-After); used when longer than the jittered delay. */
  retryAfterMs?: (err: unknown) => number | undefined;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function fullJitterDelay(attempt: number, baseMs: number, capMs: number, random: () => number = Math.random): number {
  return Math.floor(random() * Math.min(capMs, baseMs * 2 ** attempt));
}

export async function withRetry<T>(fn: (attempt: number) => Promise<T>, options: RetryOptions): Promise<T> {
  const wait = options.sleep ?? sleep;
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      if (attempt + 1 >= options.attempts || !options.isRetryable(err)) throw err;
      const jittered = fullJitterDelay(attempt, options.baseMs, options.capMs, options.random);
      await wait(Math.max(jittered, options.retryAfterMs?.(err) ?? 0));
    }
  }
}
