import {
  formatAadhaar,
  hasPermission,
  maskAadhaar,
  maskMobile,
  maskPan,
  personalResponseSchema,
  type PersonalResponse,
  type Role,
} from '@kyc-setu/shared';
import type { PlainPersonal } from '../kyc/personal-codec.js';

/** What a response may carry about a person: the details the role is meant to see, with identifiers masked. */
export interface MaskedPersonal extends PersonalResponse {
  /** `XXXXXX234F`. Staff only: a customer sees their own PAN. */
  panMasked?: string;
  mobileMasked?: string;
  /**
   * The full Aadhaar number, present in the one response of the one request that revealed it, and tagged as such.
   * Never present for a role that lacks `kyc.session.reveal_pii`, whatever was asked.
   */
  aadhaar?: { value: string; revealed: true; revealedAt: string };
}

export interface MaskOptions {
  /** This request is the audited reveal: include the full number (for a role that may have it). */
  reveal?: { at: Date };
}

const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

/**
 * The single place personal details are turned into something a response may contain. It works from the decrypted
 * values and decides, by role, what survives: handlers never build a personal-details object by hand, so a new
 * route cannot leak a raw value by forgetting to mask one.
 *
 * - CUSTOMER (looking at their own application): their own details, Aadhaar masked to its last four.
 * - OFFICER / OFFICER_LEAD / AUDITOR: names, dates and addresses, but PAN, mobile and Aadhaar masked to the last
 *   characters. The full Aadhaar appears only with `options.reveal`, and only for a role that may reveal.
 * - Anything else: nothing.
 */
export function maskForRole(
  plain: PlainPersonal,
  role: Role,
  options: MaskOptions = {},
): MaskedPersonal {
  const aadhaar = str(plain['aadhaarNumber']);
  const pan = str(plain['panNumber']);
  const mobile = str(plain['mobile']);
  const { aadhaarNumber: _a, panNumber, mobile: _m, ...rest } = plain;
  void _a;
  void _m;

  if (role === 'CUSTOMER') {
    return personalResponseSchema.parse({
      ...rest,
      ...(pan ? { panNumber } : {}),
      ...(mobile ? { mobile } : {}),
      ...(aadhaar ? { aadhaarMasked: maskAadhaar(aadhaar) } : {}),
    });
  }

  if (role === 'OFFICER' || role === 'OFFICER_LEAD' || role === 'AUDITOR') {
    const masked: MaskedPersonal = {
      ...personalResponseSchema.parse({
        ...rest,
        ...(aadhaar ? { aadhaarMasked: maskAadhaar(aadhaar) } : {}),
      }),
      ...(pan ? { panMasked: maskPan(pan) ?? '' } : {}),
      ...(mobile ? { mobileMasked: maskMobile(mobile) ?? '' } : {}),
    };
    if (options.reveal && aadhaar && hasPermission(role, 'kyc.session.reveal_pii')) {
      masked.aadhaar = {
        value: formatAadhaar(aadhaar),
        revealed: true,
        revealedAt: options.reveal.at.toISOString(),
      };
    }
    return masked;
  }

  return {};
}
