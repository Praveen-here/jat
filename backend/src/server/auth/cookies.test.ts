import { describe, expect, it } from 'vitest';
import { clearCookie, cookieNames, parseCookies, serializeCookie } from './cookies';
import { isSameOrigin } from '../http/responses';

describe('cookies', () => {
  it('serialises HttpOnly, SameSite=Lax cookies, Secure only over HTTPS', () => {
    expect(serializeCookie('sid', 'abc', { secure: false, maxAgeSeconds: 60 })).toBe(
      'sid=abc; Path=/; HttpOnly; SameSite=Lax; Max-Age=60',
    );
    expect(serializeCookie('__Host-sid', 'abc', { secure: true, maxAgeSeconds: 60 })).toContain('; Secure');
    expect(clearCookie('sid', false)).toContain('Max-Age=0');
  });

  it('uses __Host- names only in production (HTTPS)', () => {
    expect(cookieNames(true).session).toBe('__Host-sid');
    expect(cookieNames(false).session).toBe('sid');
  });

  it('parses a Cookie header, keeping the first value of duplicates and ignoring junk', () => {
    const cookies = parseCookies('sid=one; theme=light; sid=two; bad; x=%E0%A4%A');
    expect(cookies.get('sid')).toBe('one');
    expect(cookies.get('theme')).toBe('light');
    expect(cookies.has('bad')).toBe(false);
    expect(cookies.has('x')).toBe(false);
    expect(parseCookies(null).size).toBe(0);
  });
});

describe('isSameOrigin', () => {
  const appUrl = 'http://localhost:3000';
  const post = (origin?: string) =>
    new Request('http://localhost:4000/api/auth/logout', { method: 'POST', headers: origin ? { origin } : {} });

  it('accepts our own origin and rejects others or a missing Origin', () => {
    expect(isSameOrigin(post('http://localhost:3000'), appUrl)).toBe(true);
    expect(isSameOrigin(post('https://evil.example'), appUrl)).toBe(false);
    expect(isSameOrigin(post(), appUrl)).toBe(false);
  });
});
