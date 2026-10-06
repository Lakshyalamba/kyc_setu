import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export interface DataKey {
  /** The raw 32-byte data-encryption key. Use it, then zero it. */
  plaintext: Buffer;
  /** The same key encrypted by the KMS master key; safe to store next to the data. */
  wrapped: Buffer;
  /** Identifies which master key wrapped it, so keys can be rotated. */
  keyId: string;
}

/** The only thing envelope encryption needs from a key-management service. */
export interface KmsClient {
  generateDataKey(): Promise<DataKey>;
  decryptDataKey(wrapped: Buffer, keyId: string): Promise<Buffer>;
}

export const LOCAL_KEY_ID = 'local:v1';

/**
 * Development KMS: wraps data keys with AES-256-GCM under a master key from the environment.
 * NOT for production, because the master key sits next to the app. Use a real KMS there.
 */
export class LocalKmsClient implements KmsClient {
  constructor(private readonly masterKey: Buffer) {
    if (masterKey.length !== 32) throw new Error('KMS_LOCAL_MASTER_KEY must be 32 bytes (base64)');
  }

  /** `KMS_LOCAL_MASTER_KEY`: 32 random bytes, base64. Generate: `openssl rand -base64 32`. */
  static fromBase64(base64: string): LocalKmsClient {
    return new LocalKmsClient(Buffer.from(base64, 'base64'));
  }

  async generateDataKey(): Promise<DataKey> {
    const plaintext = randomBytes(32);
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.masterKey, iv);
    const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    // wrapped = iv(12) | tag(16) | ciphertext(32)
    return {
      plaintext,
      wrapped: Buffer.concat([iv, cipher.getAuthTag(), ct]),
      keyId: LOCAL_KEY_ID,
    };
  }

  async decryptDataKey(wrapped: Buffer, keyId: string): Promise<Buffer> {
    if (keyId !== LOCAL_KEY_ID)
      throw new Error(`LocalKmsClient cannot unwrap keys from "${keyId}"`);
    if (wrapped.length !== 60) throw new Error('Malformed wrapped data key');
    const decipher = createDecipheriv('aes-256-gcm', this.masterKey, wrapped.subarray(0, 12));
    decipher.setAuthTag(wrapped.subarray(12, 28));
    return Buffer.concat([decipher.update(wrapped.subarray(28)), decipher.final()]);
  }
}

/** Placeholder for the production KMS; wired up in a later phase. */
export class AwsKmsClient implements KmsClient {
  constructor(readonly keyId?: string) {}
  generateDataKey(): Promise<DataKey> {
    return Promise.reject(new Error('AWS KMS is not configured'));
  }
  decryptDataKey(): Promise<Buffer> {
    return Promise.reject(new Error('AWS KMS is not configured'));
  }
}
