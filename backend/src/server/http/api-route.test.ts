import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createLogger } from '../lib/logger';
import { apiRoute } from './api-route';

function captureDeps() {
  const lines: string[] = [];
  const destination = new Writable({
    write(chunk, _encoding, callback) {
      lines.push(chunk.toString());
      callback();
    },
  });
  const logger = createLogger({ level: 'info', service: 'test', destination });
  return { deps: { getLogger: () => logger }, logs: () => lines.map((l) => JSON.parse(l) as Record<string, unknown>) };
}

describe('apiRoute', () => {
  it('passes the response through and logs route, status and duration', async () => {
    const { deps, logs } = captureDeps();
    const handler = apiRoute('GET /api/test', async () => Response.json({ ok: true }), deps);

    const response = await handler(new Request('http://localhost/api/test?code=secret-oauth-code'), {});

    expect(response.status).toBe(200);
    expect(response.headers.get('X-Request-Id')).toMatch(/^[0-9a-f-]{36}$/);
    const [entry] = logs();
    expect(entry).toMatchObject({ route: 'GET /api/test', method: 'GET', statusCode: 200 });
    expect(JSON.stringify(logs())).not.toContain('secret-oauth-code');
  });

  it('turns unexpected errors into a safe 500 without leaking details', async () => {
    const { deps, logs } = captureDeps();
    const handler = apiRoute(
      'GET /api/boom',
      async () => {
        throw new Error('db exploded for student@gmail.com');
      },
      deps,
    );

    const response = await handler(new Request('http://localhost/api/boom'), {});
    const body = (await response.json()) as { error: { code: string; message: string } };

    expect(response.status).toBe(500);
    expect(body.error.code).toBe('INTERNAL');
    expect(body.error.message).not.toContain('db exploded');
    expect(JSON.stringify(logs())).not.toContain('student@gmail.com');
  });
});
