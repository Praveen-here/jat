import { createHash, createHmac, randomBytes } from 'node:crypto';

/**
 * Keyed hash (HMAC-SHA256) for fingerprints we store, like email Message-IDs. Unlike a plain
 * hash, it can't be matched against outside data without the secret pepper.
 */
export function hmacHex(pepper: string, value: string): string {
  return createHmac('sha256', pepper).update(value).digest('hex');
}

/** URL-safe random token. 32 bytes = 256 bits: unguessable. */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/** One-way hash used to store tokens: the database never holds a usable token. */
export function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** PKCE S256 challenge for a code verifier (RFC 7636). */
export function pkceChallenge(codeVerifier: string): string {
  return createHash('sha256').update(codeVerifier).digest('base64url');
}
