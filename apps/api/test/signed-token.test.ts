import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  createFileToken,
  parseFileToken,
  verifyFileToken,
  type TokenFields,
} from '../src/modules/documents/signed-token.js';

const SECRET = 's'.repeat(40);
const fields = (): TokenFields => ({
  issueId: randomUUID(),
  documentId: randomUUID(),
  purpose: 'CUSTOMER_PREVIEW',
  issuedToUserId: randomUUID(),
  expiresAtMs: Date.now() + 300_000,
});

describe('file tokens', () => {
  it('round-trips and verifies', () => {
    const f = fields();
    const token = createFileToken(f, SECRET);
    expect(token).toMatch(/^[A-Za-z0-9_-]{75}$/);
    const parsed = parseFileToken(token);
    expect(parsed).toMatchObject({ issueId: f.issueId, expiresAtMs: f.expiresAtMs });
    expect(parsed && verifyFileToken(parsed, f, SECRET)).toBe(true);
  });

  it('is opaque: the document id and user id appear nowhere in it', () => {
    const f = fields();
    const token = createFileToken(f, SECRET);
    const decoded = Buffer.from(token, 'base64url').toString('hex');
    for (const id of [f.documentId, f.issuedToUserId]) {
      expect(token).not.toContain(id);
      expect(decoded).not.toContain(id.replace(/-/g, ''));
    }
  });

  it('is bound to every field and to the secret', () => {
    const f = fields();
    const parsed = parseFileToken(createFileToken(f, SECRET));
    if (!parsed) throw new Error('unparseable');
    expect(verifyFileToken(parsed, { ...f, documentId: randomUUID() }, SECRET)).toBe(false);
    expect(verifyFileToken(parsed, { ...f, purpose: 'OFFICER_REVIEW' }, SECRET)).toBe(false);
    expect(verifyFileToken(parsed, { ...f, issuedToUserId: randomUUID() }, SECRET)).toBe(false);
    expect(verifyFileToken(parsed, { ...f, expiresAtMs: f.expiresAtMs + 1 }, SECRET)).toBe(false);
    expect(verifyFileToken(parsed, f, 'x'.repeat(40))).toBe(false);
  });

  it('rejects a tampered mac or expiry, and malformed tokens', () => {
    const f = fields();
    const bytes = Buffer.from(createFileToken(f, SECRET), 'base64url');
    bytes[40] = (bytes[40] ?? 0) ^ 1; // flip a MAC bit
    const forged = parseFileToken(bytes.toString('base64url'));
    expect(forged && verifyFileToken(forged, f, SECRET)).toBe(false);

    const later = Buffer.from(createFileToken(f, SECRET), 'base64url');
    later.writeBigUInt64BE(BigInt(f.expiresAtMs + 60_000), 16); // extend own expiry
    const extended = parseFileToken(later.toString('base64url'));
    expect(
      extended && verifyFileToken(extended, { ...f, expiresAtMs: f.expiresAtMs + 60_000 }, SECRET),
    ).toBe(false);

    expect(parseFileToken('short')).toBeNull();
    expect(parseFileToken('')).toBeNull();
  });
});
