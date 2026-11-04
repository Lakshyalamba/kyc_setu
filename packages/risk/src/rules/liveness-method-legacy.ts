import type { RiskConfig } from '../config.js';
import type { Rule } from '../types.js';
import { APPLICABLE, skip } from './helpers.js';

export const ID = 'liveness-method-legacy' as const;

/**
 * Informational, weight 0. Fires when the passive anti-spoofing model is supposed to count but this selfie was judged by the
 * motion check alone: it was taken before the model existed, or the model timed out. It is listed for the officer so they know
 * how much weight the selfie's check can bear, and it never moves a score or a band.
 */
export const livenessMethodLegacy = (config: RiskConfig): Rule => ({
  id: ID,
  category: 'biometric',
  weight: config.weights[ID],
  applicableWhen: (ctx) => {
    const l = ctx.liveness;
    if (!l) return skip('No selfie has been taken');
    if (l.method === 'NONE') return skip('No check was performed (file upload)');
    return APPLICABLE;
  },
  evaluate: (ctx) =>
    ctx.liveness?.padRequired && ctx.liveness.checkMethod === 'MOTION_CHECK'
      ? {
          passed: false,
          penalty: config.weights[ID],
          reason:
            'Judged by the motion check alone: no passive anti-spoofing result counted for this selfie',
          details: { checkMethod: 'MOTION_CHECK' },
        }
      : { passed: true },
});
