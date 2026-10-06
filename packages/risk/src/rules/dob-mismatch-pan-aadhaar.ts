import type { RiskConfig } from '../config.js';
import { isValidIsoDate, isoDateEqual } from '../lib/dates.js';
import type { Rule } from '../types.js';
import { APPLICABLE, skip } from './helpers.js';

export const ID = 'dob-mismatch-pan-aadhaar' as const;

export const dobMismatchPanAadhaar = (config: RiskConfig): Rule => ({
  id: ID,
  category: 'identity',
  weight: config.weights[ID],
  applicableWhen: (ctx) => {
    const a = ctx.extractions.PAN?.dob?.value;
    const b = ctx.extractions.AADHAAR_FRONT?.dob?.value;
    return a && b && isValidIsoDate(a) && isValidIsoDate(b)
      ? APPLICABLE
      : skip('A valid date of birth was not extracted from both the PAN and the Aadhaar');
  },
  evaluate: (ctx) =>
    isoDateEqual(
      ctx.extractions.PAN?.dob?.value ?? '',
      ctx.extractions.AADHAAR_FRONT?.dob?.value ?? '',
    )
      ? { passed: true }
      : {
          passed: false,
          penalty: config.weights[ID],
          reason: 'Date of birth on the PAN and on the Aadhaar are different days',
        },
});
