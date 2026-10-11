/**
 * Minimal cookie helpers for route handlers (they receive a plain Request).
 *
 * In production (HTTPS) cookies use the `__Host-` prefix, which browsers only accept with
 * Secure, Path=/ and no Domain: the cookie can't be set or read by any other subdomain.
 * Plain http://localhost can't use Secure cookies reliably, so development uses plain names.
 */
export interface CookieNames {
  session: string;
  oauthBinding: string;
}

export function cookieNames(secure: boolean): CookieNames {
  return secure
    ? { session: '__Host-sid', oauthBinding: '__Host-oauth' }
    : { session: 'sid', oauthBinding: 'oauth_binding' };
}

export function parseCookies(header: string | null): Map<string, string> {
  const cookies = new Map<string, string>();
  if (!header) return cookies;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index <= 0) continue;
    const name = part.slice(0, index).trim();
    const raw = part.slice(index + 1).trim();
    if (!name || cookies.has(name)) continue;
    try {
      cookies.set(name, decodeURIComponent(raw));
    } catch {
      // Ignore malformed values rather than failing the request.
    }
  }
  return cookies;
}

export function readCookie(request: Request, name: string): string | undefined {
  return parseCookies(request.headers.get('cookie')).get(name);
}

export interface CookieOptions {
  secure: boolean;
  maxAgeSeconds: number;
}

/** HttpOnly (no JavaScript access), SameSite=Lax (not sent on cross-site POSTs), Path=/. */
export function serializeCookie(name: string, value: string, options: CookieOptions): string {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.max(0, Math.floor(options.maxAgeSeconds))}`,
  ];
  if (options.secure) parts.push('Secure');
  return parts.join('; ');
}

export function clearCookie(name: string, secure: boolean): string {
  return serializeCookie(name, '', { secure, maxAgeSeconds: 0 });
}
