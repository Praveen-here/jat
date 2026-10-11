/**
 * Redirect with optional Set-Cookie headers. Built by hand because Response.redirect() returns
 * immutable headers, which would block adding cookies and the request ID.
 */
export function redirectTo(location: string, setCookies: string[] = [], status: 302 | 303 = 302): Response {
  const headers = new Headers({ Location: location });
  for (const cookie of setCookies) headers.append('Set-Cookie', cookie);
  return new Response(null, { status, headers });
}

/**
 * CSRF defence for state-changing requests (POST, DELETE…): browsers always send Origin on
 * these, and a forged request from another site carries that site's origin.
 * Combined with SameSite=Lax session cookies.
 */
export function isSameOrigin(request: Request, appUrl: string): boolean {
  const origin = request.headers.get('origin');
  return origin !== null && origin === new URL(appUrl).origin;
}
