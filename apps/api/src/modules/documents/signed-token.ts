import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Opaque download token for GET /files/<token>:
 *
 *   base64url( issueId (16 bytes) | expiresAtMs (uint64 BE, 8 bytes) | mac (32 bytes) )
 *
 * The token reveals only a random SignedUrlIssue id and an expiry, never the document id. The MAC
 * is HMAC-SHA256 over the issue's *server-side* fields (document, purpose, recipient, expiry), so
 * the proxy recomputes it from the database row and a token can't be reused for anything else.
 */
export interface TokenFields {
  issueId: string;
  documentId: string;
  purpose: string;
  issuedToUserId: string;
  expiresAtMs: number;
}

export interface ParsedToken {
  issueId: string;
  expiresAtMs: number;
  mac: Buffer;
}

const macOf = (secret: string, f: TokenFields): Buffer =>
  createHmac('sha256', secret)
    .update(`v1|${f.issueId}|${f.documentId}|${f.purpose}|${f.issuedToUserId}|${f.expiresAtMs}`)
    .digest();

const uuidToBytes = (uuid: string): Buffer => Buffer.from(uuid.replace(/-/g, ''), 'hex');
const bytesToUuid = (b: Buffer): string => {
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
};

export function createFileToken(fields: TokenFields, secret: string): string {
  const expiry = Buffer.alloc(8);
  expiry.writeBigUInt64BE(BigInt(fields.expiresAtMs));
  return Buffer.concat([uuidToBytes(fields.issueId), expiry, macOf(secret, fields)]).toString(
    'base64url',
  );
}

/** Structure only; the MAC is checked by `verifyFileToken` once the issue row is loaded. */
export function parseFileToken(token: string): ParsedToken | null {
  const buf = Buffer.from(token, 'base64url');
  if (buf.length !== 56) return null;
  return {
    issueId: bytesToUuid(buf.subarray(0, 16)),
    expiresAtMs: Number(buf.readBigUInt64BE(16)),
    mac: buf.subarray(24),
  };
}

export function verifyFileToken(parsed: ParsedToken, fields: TokenFields, secret: string): boolean {
  if (parsed.issueId !== fields.issueId || parsed.expiresAtMs !== fields.expiresAtMs) return false;
  const expected = macOf(secret, fields);
  return expected.length === parsed.mac.length && timingSafeEqual(expected, parsed.mac);
}
