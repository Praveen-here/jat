import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { keyEncryptionKeyFromBase64, openSecret, sealSecret } from './vault';

const kek = keyEncryptionKeyFromBase64(randomBytes(32).toString('base64'));
const secret = '1//0gExampleRefreshTokenValue';

describe('vault', () => {
  it('round-trips a secret', () => {
    expect(openSecret(sealSecret(secret, 'acct-1', kek), 'acct-1', kek)).toBe(secret);
  });

  it('never stores the plaintext, and encrypts the same secret differently each time', () => {
    const a = sealSecret(secret, 'acct-1', kek);
    const b = sealSecret(secret, 'acct-1', kek);
    expect(a.ciphertext.toString('utf8')).not.toContain(secret);
    expect(a.ciphertext.equals(b.ciphertext)).toBe(false);
    expect(a.wrappedDek.equals(b.wrappedDek)).toBe(false);
  });

  it('refuses to decrypt a ciphertext moved to another row (AAD binding)', () => {
    expect(() => openSecret(sealSecret(secret, 'acct-1', kek), 'acct-2', kek)).toThrow();
  });

  it('detects tampering with the ciphertext or the wrapped key', () => {
    const sealed = sealSecret(secret, 'acct-1', kek);
    const flipped = Buffer.from(sealed.ciphertext);
    flipped[0] = flipped[0]! ^ 0xff;
    expect(() => openSecret({ ...sealed, ciphertext: flipped }, 'acct-1', kek)).toThrow();

    const wrapped = Buffer.from(sealed.wrappedDek);
    wrapped[wrapped.length - 1] = wrapped[wrapped.length - 1]! ^ 0xff;
    expect(() => openSecret({ ...sealed, wrappedDek: wrapped }, 'acct-1', kek)).toThrow();
  });

  it('cannot be opened with a different key', () => {
    const otherKek = keyEncryptionKeyFromBase64(randomBytes(32).toString('base64'));
    expect(() => openSecret(sealSecret(secret, 'acct-1', kek), 'acct-1', otherKek)).toThrow();
  });

  it('rejects keys that are not 32 bytes', () => {
    expect(() => keyEncryptionKeyFromBase64(randomBytes(16).toString('base64'))).toThrow(/32 bytes/);
  });
});
