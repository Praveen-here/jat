import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Envelope encryption for secrets at rest (Gmail refresh tokens).
 *
 *   secret ──AES-256-GCM(DEK)──▶ ciphertext      one fresh random data key (DEK) per secret
 *   DEK    ──AES-256-GCM(KEK)──▶ wrapped DEK     key-encryption key (KEK) from the environment
 *
 * The database holds only ciphertext and the wrapped DEK; the KEK never touches the database.
 * `aad` (additional authenticated data) binds a ciphertext to its row: a ciphertext copied
 * onto another row fails to decrypt. GCM also detects any tampering.
 * `kekId` lets the KEK be rotated later (re-wrap DEKs; secrets themselves need not change).
 */
const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;

export interface KeyEncryptionKey {
  id: string;
  key: Buffer;
}

export interface SealedSecret {
  kekId: string;
  wrappedDek: Buffer;
  iv: Buffer;
  ciphertext: Buffer;
}

export function keyEncryptionKeyFromBase64(base64: string, id = 'env-v1'): KeyEncryptionKey {
  const key = Buffer.from(base64, 'base64');
  if (key.length !== KEY_BYTES) {
    throw new Error(`Encryption key must be ${KEY_BYTES} bytes (base64-encoded); got ${key.length}`);
  }
  return { id, key };
}

function encrypt(key: Buffer, iv: Buffer, plaintext: Buffer, aad: string): Buffer {
  const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  return Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
}

function decrypt(key: Buffer, iv: Buffer, sealed: Buffer, aad: string): Buffer {
  if (sealed.length < TAG_BYTES) throw new Error('Ciphertext too short');
  const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
  decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(sealed.subarray(sealed.length - TAG_BYTES));
  return Buffer.concat([decipher.update(sealed.subarray(0, sealed.length - TAG_BYTES)), decipher.final()]);
}

export function sealSecret(plaintext: string, aad: string, kek: KeyEncryptionKey): SealedSecret {
  const dek = randomBytes(KEY_BYTES);
  try {
    const iv = randomBytes(IV_BYTES);
    const ciphertext = encrypt(dek, iv, Buffer.from(plaintext, 'utf8'), aad);
    const wrapIv = randomBytes(IV_BYTES);
    const wrappedDek = Buffer.concat([wrapIv, encrypt(kek.key, wrapIv, dek, `dek|${aad}`)]);
    return { kekId: kek.id, wrappedDek, iv, ciphertext };
  } finally {
    dek.fill(0);
  }
}

export function openSecret(sealed: SealedSecret, aad: string, kek: KeyEncryptionKey): string {
  if (sealed.kekId !== kek.id) throw new Error(`Secret was sealed with key "${sealed.kekId}", not "${kek.id}"`);
  const wrapIv = sealed.wrappedDek.subarray(0, IV_BYTES);
  const dek = decrypt(kek.key, wrapIv, sealed.wrappedDek.subarray(IV_BYTES), `dek|${aad}`);
  try {
    return decrypt(dek, sealed.iv, sealed.ciphertext, aad).toString('utf8');
  } finally {
    dek.fill(0);
  }
}
