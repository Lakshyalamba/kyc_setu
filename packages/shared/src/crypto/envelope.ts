import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { Readable } from 'node:stream';
import type { KmsClient } from './kms.js';

/** Everything needed (besides the KMS) to decrypt one object. Stored alongside the object's row. */
export interface EnvelopeMeta {
  wrappedKey: Buffer;
  iv: Buffer;
  authTag: Buffer;
  kmsKeyId: string;
}

export interface EncryptedStream {
  ciphertext: Readable;
  /** Resolves once the whole input has been consumed (the GCM tag only exists at the end). */
  meta: Promise<EnvelopeMeta>;
}

/**
 * Envelope encryption: a fresh random data key per object encrypts the bytes (AES-256-GCM); the KMS
 * wraps that data key. Ciphertext length equals plaintext length (the tag is returned separately).
 */
export async function encryptStream(plaintext: Readable, kms: KmsClient): Promise<EncryptedStream> {
  const dataKey = await kms.generateDataKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', dataKey.plaintext, iv);
  dataKey.plaintext.fill(0); // the cipher holds its own copy

  const meta = new Promise<EnvelopeMeta>((resolve, reject) => {
    cipher.once('end', () =>
      resolve({
        wrappedKey: dataKey.wrapped,
        iv,
        authTag: cipher.getAuthTag(),
        kmsKeyId: dataKey.keyId,
      }),
    );
    cipher.once('error', reject);
  });
  meta.catch(() => undefined); // a failed encryption is reported through the stream; don't also crash on this copy

  plaintext.once('error', (err) => cipher.destroy(err));
  plaintext.pipe(cipher);
  return { ciphertext: cipher, meta };
}

async function makeDecipher(meta: EnvelopeMeta, kms: KmsClient) {
  const key = await kms.decryptDataKey(meta.wrappedKey, meta.kmsKeyId);
  const decipher = createDecipheriv('aes-256-gcm', key, meta.iv);
  key.fill(0);
  decipher.setAuthTag(meta.authTag);
  return decipher;
}

/**
 * Streams plaintext out as ciphertext comes in.
 *
 * WARNING: GCM authenticates only at the very end, so chunks are emitted BEFORE the tag is
 * verified; a tampered object errors the stream only after most of it was already delivered.
 * Never forward this stream to an untrusted reader. Use `decryptToBuffer` for that.
 */
export async function decryptStream(
  ciphertext: Readable,
  meta: EnvelopeMeta,
  kms: KmsClient,
): Promise<Readable> {
  const decipher = await makeDecipher(meta, kms);
  ciphertext.once('error', (err) => decipher.destroy(err));
  return ciphertext.pipe(decipher);
}

/** Authenticate-then-release: rejects (returning no bytes at all) if the data was tampered with. */
export async function decryptToBuffer(
  ciphertext: Readable,
  meta: EnvelopeMeta,
  kms: KmsClient,
): Promise<Buffer> {
  const plain = await decryptStream(ciphertext, meta, kms);
  const chunks: Buffer[] = [];
  for await (const chunk of plain) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

/** Convenience for tests and small payloads. */
export async function readAll(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}
