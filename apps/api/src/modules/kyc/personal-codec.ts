import { maskAadhaar, personalResponseSchema, type PersonalResponse } from '@kyc-setu/shared';
import { decryptPii, encryptPii } from '@kyc-setu/shared/pii';

/** Fields stored AES-GCM encrypted inside the personalDetails JSONB. */
const SENSITIVE = ['panNumber', 'aadhaarNumber'] as const;

export type PlainPersonal = Record<string, unknown>;

const asRecord = (v: unknown): PlainPersonal =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as PlainPersonal) : {};

/** Stored JSON -> plain values (decrypting sensitive fields). */
export function decryptStored(stored: unknown, key: Buffer): PlainPersonal {
  const out = { ...asRecord(stored) };
  for (const f of SENSITIVE) {
    const v = out[f];
    if (typeof v === 'string') out[f] = decryptPii(v, key);
  }
  return out;
}

/** Plain values -> storable JSON (encrypting sensitive fields). */
export function encryptForStorage(plain: PlainPersonal, key: Buffer): PlainPersonal {
  const out = { ...plain };
  for (const f of SENSITIVE) {
    const v = out[f];
    if (typeof v === 'string') out[f] = encryptPii(v, key);
  }
  return out;
}

/** Merge a validated partial draft over existing plain values (address merges one level deep). */
export function mergeDraft(existing: PlainPersonal, draft: PlainPersonal): PlainPersonal {
  const { address: draftAddress, ...rest } = draft;
  const merged: PlainPersonal = { ...existing, ...rest };
  if (draftAddress !== undefined) {
    merged['address'] = { ...asRecord(existing['address']), ...asRecord(draftAddress) };
  }
  return merged;
}

/** Names of fields whose value differs between `before` and `after` (e.g. `address.city`). Never values. */
export function changedFieldNames(before: PlainPersonal, after: PlainPersonal): string[] {
  const names: string[] = [];
  for (const [k, v] of Object.entries(after)) {
    if (k === 'address') {
      const prev = asRecord(before['address']);
      for (const [ak, av] of Object.entries(asRecord(v))) {
        if (prev[ak] !== av) names.push(`address.${ak}`);
      }
    } else if (before[k] !== v) {
      names.push(k);
    }
  }
  return names.sort();
}

/** Plain values -> API response shape: Aadhaar masked, never returned in full. */
export function toPersonalResponse(plain: PlainPersonal): PersonalResponse {
  const { aadhaarNumber, ...rest } = plain;
  return personalResponseSchema.parse({
    ...rest,
    ...(typeof aadhaarNumber === 'string' ? { aadhaarMasked: maskAadhaar(aadhaarNumber) } : {}),
  });
}
