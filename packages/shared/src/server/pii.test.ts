import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { decryptPii, encryptPii, isEncrypted, parsePiiKey } from './pii.js';

const key = randomBytes(32);

describe('pii encryption', () => {
  it('round-trips and never contains the plaintext', () => {
    const token = encryptPii('234123412346', key);
    expect(isEncrypted(token)).toBe(true);
    expect(token).not.toContain('234123412346');
    expect(decryptPii(token, key)).toBe('234123412346');
  });
  it('uses a fresh IV each time', () => {
    expect(encryptPii('x', key)).not.toBe(encryptPii('x', key));
  });
  it('fails with the wrong key or tampered data', () => {
    const token = encryptPii('secret', key);
    expect(() => decryptPii(token, randomBytes(32))).toThrow();
    const tampered = token.slice(0, -2) + (token.endsWith('AA') ? 'BB' : 'AA');
    expect(() => decryptPii(tampered, key)).toThrow();
  });
  it('validates key length', () => {
    expect(() => parsePiiKey('c2hvcnQ=')).toThrow(/32 bytes/);
    expect(parsePiiKey(randomBytes(32).toString('base64'))).toHaveLength(32);
  });
});
