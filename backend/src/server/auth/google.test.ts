import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';
import { pkceChallenge } from './crypto';
import {
  buildAuthorizationUrl,
  exchangeCode,
  GMAIL_CONNECT_SCOPES,
  GMAIL_READONLY_SCOPE,
  GoogleOAuthError,
  hasGrantedScope,
  LOGIN_SCOPES,
  refreshAccessToken,
  revokeToken,
  verifyIdToken,
} from './google';

describe('Gmail connect scopes', () => {
  it('asks for read-only Gmail and nothing that can send, modify or delete mail', () => {
    expect(GMAIL_CONNECT_SCOPES).toContain(GMAIL_READONLY_SCOPE);
    expect(GMAIL_CONNECT_SCOPES.join(' ')).not.toMatch(/gmail\.(modify|send|compose|insert)|mail\.google\.com/);
  });

  it('detects when the user unticked Gmail on the consent screen', () => {
    expect(hasGrantedScope(`openid ${GMAIL_READONLY_SCOPE}`, GMAIL_READONLY_SCOPE)).toBe(true);
    expect(hasGrantedScope('openid https://www.googleapis.com/auth/userinfo.email', GMAIL_READONLY_SCOPE)).toBe(false);
    expect(hasGrantedScope(undefined, GMAIL_READONLY_SCOPE)).toBe(false);
  });
});

describe('refreshAccessToken and revokeToken', () => {
  it('returns a new access token, and a rotated refresh token when Google sends one', async () => {
    const fakeFetch = (async () =>
      Response.json({ access_token: 'new-at', expires_in: 3599, refresh_token: 'rotated' })) as unknown as typeof fetch;
    expect(await refreshAccessToken({ clientId: 'c', clientSecret: 's' }, 'rt', fakeFetch)).toEqual({
      accessToken: 'new-at',
      expiresIn: 3599,
      refreshToken: 'rotated',
    });
  });

  it('reports invalid_grant when access was revoked', async () => {
    const fakeFetch = (async () => Response.json({ error: 'invalid_grant' }, { status: 400 })) as unknown as typeof fetch;
    await expect(refreshAccessToken({ clientId: 'c', clientSecret: 's' }, 'rt', fakeFetch)).rejects.toMatchObject({
      code: 'invalid_grant',
    });
  });

  it('treats an already-invalid token as revoked, and other failures as errors', async () => {
    const status = (code: number) => (async () => new Response(null, { status: code })) as unknown as typeof fetch;
    await expect(revokeToken('t', status(200))).resolves.toBeUndefined();
    await expect(revokeToken('t', status(400))).resolves.toBeUndefined();
    await expect(revokeToken('t', status(503))).rejects.toBeInstanceOf(GoogleOAuthError);
  });
});

const config = { clientId: 'client-123.apps.googleusercontent.com', clientSecret: 'shh', redirectUri: 'http://localhost:3000/cb' };

describe('buildAuthorizationUrl', () => {
  it('asks only for identity scopes, with state, nonce and PKCE S256', () => {
    const url = new URL(
      buildAuthorizationUrl(config, { scopes: LOGIN_SCOPES, state: 's', nonce: 'n', codeChallenge: 'c', prompt: 'select_account' }),
    );
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(url.searchParams.get('scope')).toBe('openid email profile');
    expect(url.searchParams.get('scope')).not.toContain('gmail');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ state: 's', nonce: 'n', code_challenge: 'c', response_type: 'code' });
  });

  it('computes the RFC 7636 example challenge', () => {
    expect(pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  });
});

describe('exchangeCode', () => {
  it('sends the code verifier and returns the tokens', async () => {
    let sentBody = '';
    const fakeFetch = (async (_url: string, init: RequestInit) => {
      sentBody = String(init.body);
      return Response.json({ id_token: 'idt', access_token: 'at', expires_in: 3599, scope: 'openid' });
    }) as unknown as typeof fetch;

    const tokens = await exchangeCode(config, 'the-code', 'the-verifier', fakeFetch);
    expect(tokens).toMatchObject({ idToken: 'idt', accessToken: 'at', expiresIn: 3599 });
    expect(new URLSearchParams(sentBody).get('code_verifier')).toBe('the-verifier');
  });

  it("surfaces Google's error code only", async () => {
    const fakeFetch = (async () =>
      Response.json({ error: 'invalid_grant', error_description: 'Bad Request' }, { status: 400 })) as unknown as typeof fetch;
    await expect(exchangeCode(config, 'x', 'y', fakeFetch)).rejects.toMatchObject({ code: 'invalid_grant' });
  });
});

describe('verifyIdToken', () => {
  let privateKey: CryptoKey;
  let keys: ReturnType<typeof createLocalJWKSet>;

  beforeAll(async () => {
    const pair = await generateKeyPair('RS256');
    privateKey = pair.privateKey;
    keys = createLocalJWKSet({ keys: [{ ...(await exportJWK(pair.publicKey)), alg: 'RS256', kid: 'k1' }] });
  });

  function sign(claims: Record<string, unknown>, overrides: { iss?: string; aud?: string; exp?: string } = {}) {
    return new SignJWT({ email: 'me@gmail.com', email_verified: true, name: 'Me', nonce: 'n1', ...claims })
      .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
      .setSubject('sub-1')
      .setIssuer(overrides.iss ?? 'https://accounts.google.com')
      .setAudience(overrides.aud ?? config.clientId)
      .setIssuedAt()
      .setExpirationTime(overrides.exp ?? '5m')
      .sign(privateKey);
  }

  it('accepts a valid token', async () => {
    const identity = await verifyIdToken(await sign({}), { clientId: config.clientId, nonce: 'n1', keys });
    expect(identity).toEqual({ subject: 'sub-1', email: 'me@gmail.com', emailVerified: true, name: 'Me' });
  });

  it('rejects a wrong nonce (replayed token)', async () => {
    await expect(verifyIdToken(await sign({ nonce: 'other' }), { clientId: config.clientId, nonce: 'n1', keys })).rejects.toBeInstanceOf(
      GoogleOAuthError,
    );
  });

  it('rejects a token for another app, another issuer, or expired', async () => {
    const options = { clientId: config.clientId, nonce: 'n1', keys };
    await expect(verifyIdToken(await sign({}, { aud: 'someone-else' }), options)).rejects.toThrow();
    await expect(verifyIdToken(await sign({}, { iss: 'https://evil.example' }), options)).rejects.toThrow();
    await expect(verifyIdToken(await sign({}, { exp: '-1m' }), options)).rejects.toThrow();
  });

  it('rejects a token signed by a different key', async () => {
    const other = await generateKeyPair('RS256');
    const forged = await new SignJWT({ nonce: 'n1', email: 'me@gmail.com' })
      .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
      .setSubject('sub-1')
      .setIssuer('https://accounts.google.com')
      .setAudience(config.clientId)
      .setExpirationTime('5m')
      .sign(other.privateKey);
    await expect(verifyIdToken(forged, { clientId: config.clientId, nonce: 'n1', keys })).rejects.toThrow();
  });
});
