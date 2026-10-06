/** Field-level AES-256-GCM encryption for PII at rest. Node-only (not exported from the root entry). */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const PREFIX = 'enc:v1:';

/** `PII_ENCRYPTION_KEY` is 32 random bytes, base64 encoded. Generate: `openssl rand -base64 32`. */
export function parsePiiKey(base64: string): Buffer {
  const key = Buffer.from(base64, 'base64');
  if (key.length !== 32) throw new Error('PII encryption key must be 32 bytes (base64 encoded)');
  return key;
}

export const isEncrypted = (value: string): boolean => value.startsWith(PREFIX);

export function encryptPii(plaintext: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return PREFIX + Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64');
}

export function decryptPii(token: string, key: Buffer): string {
  if (!isEncrypted(token)) throw new Error('Value is not an encrypted PII token');
  const raw = Buffer.from(token.slice(PREFIX.length), 'base64');
  const decipher = createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
  decipher.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
}
