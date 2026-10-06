import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import {
  decryptStream,
  decryptToBuffer,
  encryptBuffer,
  encryptStream,
  readAll,
} from './envelope.js';
import { AwsKmsClient, LocalKmsClient } from './kms.js';

const kms = () => new LocalKmsClient(randomBytes(32));
const KNOWN = Buffer.from('PAN card bytes \u0000ÿ\u0001 — known fixture');

/** Feeds the buffer in small chunks so multi-chunk streaming is exercised. */
const chunked = (buf: Buffer, size = 7) =>
  Readable.from(
    Array.from({ length: Math.ceil(buf.length / size) }, (_, i) =>
      buf.subarray(i * size, (i + 1) * size),
    ),
  );

async function encrypt(plain: Buffer, k = kms()) {
  const { ciphertext, meta } = await encryptStream(chunked(plain), k);
  const bytes = await readAll(ciphertext);
  return { bytes, meta: await meta, kms: k };
}

describe('envelope encryption', () => {
  it('round-trips a known buffer', async () => {
    const { bytes, meta, kms: k } = await encrypt(KNOWN);
    expect(bytes.equals(KNOWN)).toBe(false);
    expect(bytes.length).toBe(KNOWN.length); // GCM: no padding, tag is stored separately
    expect(meta).toMatchObject({ kmsKeyId: 'local:v1' });
    expect(meta.iv).toHaveLength(12);
    expect(meta.authTag).toHaveLength(16);

    expect((await decryptToBuffer(Readable.from([bytes]), meta, k)).equals(KNOWN)).toBe(true);
    const streamed = await readAll(await decryptStream(chunked(bytes, 5), meta, k));
    expect(streamed.equals(KNOWN)).toBe(true);
  });

  it('round-trips a large random payload (multi-chunk) and an empty one', async () => {
    const big = randomBytes(2 * 1024 * 1024 + 13);
    const { bytes, meta, kms: k } = await encrypt(big);
    expect((await decryptToBuffer(chunked(bytes, 64 * 1024), meta, k)).equals(big)).toBe(true);

    const empty = await encrypt(Buffer.alloc(0));
    expect(await decryptToBuffer(Readable.from([empty.bytes]), empty.meta, empty.kms)).toHaveLength(
      0,
    );
  });

  it('fails the auth tag if a single ciphertext byte is changed, releasing no bytes', async () => {
    const { bytes, meta, kms: k } = await encrypt(KNOWN);
    const tampered = Buffer.from(bytes);
    tampered[3] = (tampered[3] ?? 0) ^ 0x01;
    await expect(decryptToBuffer(Readable.from([tampered]), meta, k)).rejects.toThrow(
      /authenticate/i,
    );
  });

  it('stream decryption also errors on tamper (but only at the end, hence the warning)', async () => {
    const { bytes, meta, kms: k } = await encrypt(KNOWN);
    const tampered = Buffer.from(bytes);
    tampered[0] = (tampered[0] ?? 0) ^ 0xff;
    await expect(readAll(await decryptStream(Readable.from([tampered]), meta, k))).rejects.toThrow(
      /authenticate/i,
    );
  });

  it('fails on a truncated ciphertext, a wrong auth tag, a wrong IV and a tampered wrapped key', async () => {
    const { bytes, meta, kms: k } = await encrypt(KNOWN);
    const run = (b: Buffer, m = meta) => decryptToBuffer(Readable.from([b]), m, k);
    await expect(run(bytes.subarray(0, bytes.length - 1))).rejects.toThrow();
    await expect(run(bytes, { ...meta, authTag: randomBytes(16) })).rejects.toThrow();
    await expect(run(bytes, { ...meta, iv: randomBytes(12) })).rejects.toThrow();
    const badKey = Buffer.from(meta.wrappedKey);
    badKey[40] = (badKey[40] ?? 0) ^ 0x01;
    await expect(run(bytes, { ...meta, wrappedKey: badKey })).rejects.toThrow();
  });

  it('cannot be decrypted with a different master key', async () => {
    const { bytes, meta } = await encrypt(KNOWN);
    await expect(decryptToBuffer(Readable.from([bytes]), meta, kms())).rejects.toThrow();
  });

  it('uses a fresh data key and IV for every object', async () => {
    const k = kms();
    const a = await encrypt(KNOWN, k);
    const b = await encrypt(KNOWN, k);
    expect(a.bytes.equals(b.bytes)).toBe(false);
    expect(a.meta.iv.equals(b.meta.iv)).toBe(false);
    expect(a.meta.wrappedKey.equals(b.meta.wrappedKey)).toBe(false);
  });

  it('propagates errors from the source stream', async () => {
    const failing = new Readable({
      read() {
        this.destroy(new Error('socket hang up'));
      },
    });
    const { ciphertext } = await encryptStream(failing, kms());
    await expect(readAll(ciphertext)).rejects.toThrow('socket hang up');
  });
});

describe('encryptBuffer', () => {
  it('round-trips small payloads, including non-ASCII text', async () => {
    const k = kms();
    const text = Buffer.from('पता: 12 MG Road\n2341 2341 2346');
    const { ciphertext, meta } = await encryptBuffer(text, k);
    expect(ciphertext.includes(Buffer.from('MG Road'))).toBe(false);
    expect((await decryptToBuffer(Readable.from([ciphertext]), meta, k)).equals(text)).toBe(true);
  });
});

describe('KMS clients', () => {
  it('LocalKmsClient wraps and unwraps data keys, and validates the master key', async () => {
    const k = kms();
    const dk = await k.generateDataKey();
    expect(dk.plaintext).toHaveLength(32);
    expect(dk.wrapped.equals(dk.plaintext)).toBe(false);
    expect((await k.decryptDataKey(dk.wrapped, dk.keyId)).equals(dk.plaintext)).toBe(true);
    await expect(k.decryptDataKey(dk.wrapped, 'aws:other')).rejects.toThrow(/cannot unwrap/);
    expect(() => LocalKmsClient.fromBase64('c2hvcnQ=')).toThrow(/32 bytes/);
  });

  it('AwsKmsClient is a stub that refuses to run', async () => {
    const aws = new AwsKmsClient();
    await expect(aws.generateDataKey()).rejects.toThrow('AWS KMS is not configured');
    await expect(aws.decryptDataKey()).rejects.toThrow('AWS KMS is not configured');
  });
});
