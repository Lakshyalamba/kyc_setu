import type { RiskConfig } from '../config.js';
import type { Rule } from '../types.js';
import { APPLICABLE, skip } from './helpers.js';

export const ID = 'aadhaar-form-mismatch' as const;

/** As with the PAN, the full-number comparison happens in the worker; the engine only sees the answer. */
export const aadhaarFormMismatch = (config: RiskConfig): Rule => ({
  id: ID,
  category: 'identity',
  weight: config.weights[ID],
  applicableWhen: (ctx) =>
    ctx.comparisons.aadhaarTypedMatchesExtracted === null
      ? skip('The typed Aadhaar number could not be compared with the extracted one')
      : APPLICABLE,
  evaluate: (ctx) =>
    ctx.comparisons.aadhaarTypedMatchesExtracted
      ? { passed: true }
      : {
          passed: false,
          penalty: config.weights[ID],
          reason: 'The Aadhaar number typed by the customer does not match the Aadhaar on the card',
        },
});
