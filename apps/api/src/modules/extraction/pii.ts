import { createHmac, hkdfSync } from 'node:crypto';

/**
 * Keyed hash of a PAN number, for equality checks (e.g. "does the extracted PAN match the one the
 * customer typed?") without a plaintext PAN column. Derived from the PII key with HKDF so the same
 * secret is never used directly for two purposes.
 */
export function panBlindIndex(pan: string, piiKey: Buffer): string {
  const key = Buffer.from(
    hkdfSync('sha256', piiKey, Buffer.alloc(0), 'kyc-setu pan blind index v1', 32),
  );
  return createHmac('sha256', key).update(pan.trim().toUpperCase()).digest('hex');
}

const AADHAAR_IN_TEXT = /(?<!\d)([2-9]\d{3})[\s-]?(\d{4})[\s-]?(\d{4})(?!\d)/g;

/** Hides every 12-digit Aadhaar-shaped number except its last four digits. */
export function redactAadhaar(text: string): string {
  return text.replace(AADHAAR_IN_TEXT, 'XXXX XXXX $3');
}

/** `XXXX-XXXX-1234` -> `1234`. Anything else -> null. */
export function last4FromMasked(masked: string): string | null {
  return /^X{4}-X{4}-(\d{4})$/.exec(masked)?.[1] ?? null;
}
