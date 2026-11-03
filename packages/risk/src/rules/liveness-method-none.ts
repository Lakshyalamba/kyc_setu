import type { RiskConfig } from '../config.js';
import type { Rule } from '../types.js';
import { APPLICABLE, skip } from './helpers.js';

export const ID = 'liveness-method-none' as const;

/** Fires when the customer used the file-upload fallback: no motion check was possible, so a still picture stands in for a person. */
export const livenessMethodNone = (config: RiskConfig): Rule => ({
  id: ID,
  category: 'biometric',
  weight: config.weights[ID],
  applicableWhen: (ctx) => (ctx.liveness ? APPLICABLE : skip('No selfie has been taken')),
  evaluate: (ctx) =>
    ctx.liveness?.method === 'NONE'
      ? {
          passed: false,
          penalty: config.weights[ID],
          reason: 'No motion check was performed: the selfie was uploaded as a file',
          details: { method: 'NONE' },
        }
      : { passed: true },
});
