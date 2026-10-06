import type { RiskConfig } from '../config.js';
import type { Rule } from '../types.js';
import { APPLICABLE, skip } from './helpers.js';

export const ID = 'aadhaar-checksum-invalid' as const;

export const aadhaarChecksumInvalid = (config: RiskConfig): Rule => ({
  id: ID,
  category: 'data_integrity',
  weight: config.weights[ID],
  applicableWhen: (ctx) =>
    ctx.extractions.AADHAAR_FRONT?.aadhaarNumber
      ? APPLICABLE
      : skip('No Aadhaar number was extracted'),
  evaluate: (ctx) =>
    ctx.extractions.AADHAAR_FRONT?.aadhaarNumber?.checksumValid
      ? { passed: true }
      : {
          passed: false,
          penalty: config.weights[ID],
          reason: 'The Aadhaar number read from the card fails its Verhoeff checksum',
        },
});
