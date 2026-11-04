import type { RiskConfig } from '../config.js';
import type { Rule } from '../types.js';
import { APPLICABLE, skip } from './helpers.js';

export const ID = 'liveness-failed' as const;

/**
 * Fires when the liveness check that decided failed or could not be completed: the motion check (a photo held still fails it),
 * the passive anti-spoofing model, or both. Neither is production liveness or certified anti-spoofing, and the reasons name
 * the check that failed so nobody reads more into a pass than it can support.
 */
export const livenessFailed = (config: RiskConfig): Rule => ({
  id: ID,
  category: 'biometric',
  weight: config.weights[ID],
  applicableWhen: (ctx) => {
    if (!ctx.liveness) return skip('No liveness result is available');
    if (ctx.liveness.method === 'NONE') return skip('No motion check was performed (file upload)');
    return APPLICABLE;
  },
  evaluate: (ctx) => {
    const l = ctx.liveness;
    if (!l || l.result === 'PASSED' || l.result === 'NOT_PERFORMED') return { passed: true };
    const pad = l.failureReason === 'PAD_SPOOF' || l.failureReason === 'PAD_UNAVAILABLE';
    return {
      passed: false,
      penalty: config.weights[ID],
      reason: pad
        ? l.result === 'INCONCLUSIVE'
          ? 'The passive anti-spoofing check could not judge the picture'
          : 'The passive anti-spoofing check failed: the picture looks like a picture of a face'
        : l.result === 'INCONCLUSIVE'
          ? 'The motion check could not be completed (picture quality)'
          : 'The motion check failed',
      details: { result: l.result, ...(l.failureReason ? { failureReason: l.failureReason } : {}) },
    };
  },
});
