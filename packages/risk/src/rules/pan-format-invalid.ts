import type { RiskConfig } from '../config.js';
import type { Rule } from '../types.js';
import { APPLICABLE, skip } from './helpers.js';

export const ID = 'pan-format-invalid' as const;

export const panFormatInvalid = (config: RiskConfig): Rule => ({
  id: ID,
  category: 'data_integrity',
  weight: config.weights[ID],
  applicableWhen: (ctx) =>
    ctx.extractions.PAN?.panNumber ? APPLICABLE : skip('No PAN number was extracted'),
  evaluate: (ctx) =>
    ctx.extractions.PAN?.panNumber?.formatValid
      ? { passed: true }
      : {
          passed: false,
          penalty: config.weights[ID],
          reason: 'The PAN number read from the card is not a valid PAN (AAAAA9999A)',
        },
});
