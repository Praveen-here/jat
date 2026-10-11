import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createLogger, scrubString } from './logger';

function captureLogger() {
  const lines: string[] = [];
  const destination = new Writable({
    write(chunk, _encoding, callback) {
      lines.push(chunk.toString());
      callback();
    },
  });
  const logger = createLogger({ level: 'info', service: 'test', destination });
  return { logger, lines, parsed: () => lines.map((line) => JSON.parse(line) as Record<string, unknown>) };
}

describe('logger safety', () => {
  it('scrubs email addresses and tokens from the message', () => {
    const { logger, lines } = captureLogger();
    logger.info('refresh failed for student@gmail.com with token ya29.a0AfH6SMBx and 1//0gAbCdEfGhIjKlMn');
    const output = lines.join('');
    expect(output).not.toContain('student@gmail.com');
    expect(output).not.toContain('ya29.a0AfH6SMBx');
    expect(output).not.toContain('1//0gAbCdEfGhIjKlMn');
  });

  it('redacts string and object values under keys that are not allowlisted', () => {
    const { logger, parsed } = captureLogger();
    logger.info({ subject: 'Offer letter from Acme', body: { text: 'secret' }, accountId: 'acc-1', count: 3 }, 'x');
    const [entry] = parsed();
    expect(entry?.subject).toBe('[redacted]');
    expect(entry?.body).toBe('[redacted]');
    expect(entry?.accountId).toBe('acc-1');
    expect(entry?.count).toBe(3);
  });

  it('keeps numbers under unknown keys (counters are safe)', () => {
    const { logger, parsed } = captureLogger();
    logger.info({ listed: 120, fetched: 80 }, 'progress');
    expect(parsed()[0]).toMatchObject({ listed: 120, fetched: 80 });
  });

  it('scrubs error messages and drops stacks by default', () => {
    const { logger, parsed } = captureLogger();
    const error = Object.assign(new Error('could not parse header From: hr@acme.com'), { code: 'PARSE_FAILED' });
    logger.error({ err: error }, 'message failed');
    const entry = parsed()[0] as { err: Record<string, unknown> };
    expect(entry.err.type).toBe('Error');
    expect(entry.err.code).toBe('PARSE_FAILED');
    expect(entry.err.message).toBe('could not parse header From: [email]');
    expect(entry.err.stack).toBeUndefined();
  });

  it('scrubs child-logger bindings', () => {
    const { logger, parsed } = captureLogger();
    logger.child({ userId: 'u-1', mailbox: 'me@gmail.com' }).info('hello');
    const entry = parsed()[0];
    expect(entry?.userId).toBe('u-1');
    expect(entry?.mailbox).toBe('[redacted]');
  });
});

describe('scrubString', () => {
  it.each([
    ['GET /api/auth/google/callback?code=4/0AbCd&state=xyz', 'GET /api/auth/google/callback?code=[redacted]&state=[redacted]'],
    ['connect postgresql://u:p@host:5432/db failed', 'connect [connection-string] failed'],
    ['Authorization: Bearer abc.def-ghi', 'Authorization: [auth-header]'],
    ['id token eyJhbGciOi.eyJzdWIiOiIx.c2lnbmF0dXJl', 'id token [jwt]'],
    ['groq key gsk_AbCdEf1234567890XyZ', 'groq key [groq-api-key]'],
  ])('scrubs %s', (input, expected) => {
    expect(scrubString(input)).toBe(expected);
  });
});
