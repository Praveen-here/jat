import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import type { KeyEncryptionKey } from './vault';

/**
 * Encryption for the few email fields we keep for relevant emails (subject, sender, snippet).
 * AES-256-GCM with a key derived (HKDF) from the master key, so these never share a key with
 * the refresh-token vault. The AAD binds each value to its row and field: a value copied to
 * another row or column won't decrypt. Stored as iv(12) ‖ ciphertext ‖ tag(16).
 */
export function deriveContentKey(kek: KeyEncryptionKey): Buffer {
  return Buffer.from(hkdfSync('sha256', kek.key, Buffer.alloc(0), Buffer.from('job-tracker/content/v1'), 32));
}

export function sealText(key: Buffer, plaintext: string, aad: string): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  return Buffer.concat([iv, cipher.update(plaintext, 'utf8'), cipher.final(), cipher.getAuthTag()]);
}

export function openText(key: Buffer, sealed: Buffer, aad: string): string {
  const decipher = createDecipheriv('aes-256-gcm', key, sealed.subarray(0, 12));
  decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(sealed.subarray(sealed.length - 16));
  return Buffer.concat([decipher.update(sealed.subarray(12, sealed.length - 16)), decipher.final()]).toString('utf8');
}

export const contentAad = (sourceMessageId: string, field: 'subject' | 'sender' | 'snippet') =>
  `source_message:${sourceMessageId}:${field}`;
