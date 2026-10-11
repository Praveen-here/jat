import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/** .env.example is committed to git, so it must never contain real secrets. Fill in .env instead. */
const SECRET_KEYS = ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'TOKEN_ENCRYPTION_KEY', 'HMAC_PEPPER', 'GROQ_API_KEY'];

describe('.env.example', () => {
  const lines = readFileSync(fileURLToPath(new URL('../../../../.env.example', import.meta.url)), 'utf8').split(/\r?\n/);

  it.each(SECRET_KEYS)('leaves %s empty', (key) => {
    const line = lines.find((l) => l.startsWith(`${key}=`));
    expect(line, `${key} line missing from .env.example`).toBeDefined();
    expect(line, `${key} has a value in .env.example. Put secrets in .env, not .env.example`).toBe(`${key}=`);
  });
});
