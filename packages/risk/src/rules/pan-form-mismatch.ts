import type { RiskConfig } from '../config.js';
import type { Rule } from '../types.js';
import { APPLICABLE, skip } from './helpers.js';

export const ID = 'pan-form-mismatch' as const;

/** The worker compares the typed and extracted PAN (it can decrypt them); the engine only sees the answer. */
export const panFormMismatch = (config: RiskConfig): Rule => ({
  id: ID,
  category: 'identity',
  weight: config.weights[ID],
  applicableWhen: (ctx) =>
    ctx.comparisons.panTypedMatchesExtracted === null
      ? skip('The typed PAN could not be compared with the extracted one')
      : APPLICABLE,
  evaluate: (ctx) =>
    ctx.comparisons.panTypedMatchesExtracted
      ? { passed: true }
      : {
          passed: false,
          penalty: config.weights[ID],
          reason: 'The PAN typed by the customer does not match the PAN on the card',
        },
});
