import type { RiskConfig } from '../config.js';
import type { Rule } from '../types.js';
import { APPLICABLE, skip } from './helpers.js';

export const ID = 'liveness-failed' as const;

/**
 * Fires when the motion check failed or could not be completed. It is a motion check (a photo held still fails it), not
 * production liveness, and the reasons say "motion check" so nobody reads more into a pass than it can support.
 */
export const livenessFailed = (config: RiskConfig): Rule => ({
  id: ID,
  category: 'biometric',
  weight: config.weights[ID],
  applicableWhen: (ctx) => {
    if (!ctx.liveness) return skip('No motion-check result is available');
    if (ctx.liveness.method === 'NONE') return skip('No motion check was performed (file upload)');
    return APPLICABLE;
  },
  evaluate: (ctx) => {
    const l = ctx.liveness;
    if (!l || l.result === 'PASSED' || l.result === 'NOT_PERFORMED') return { passed: true };
    return {
      passed: false,
      penalty: config.weights[ID],
      reason:
        l.result === 'INCONCLUSIVE'
          ? 'The motion check could not be completed (picture quality)'
          : 'The motion check failed',
      details: { result: l.result, ...(l.failureReason ? { failureReason: l.failureReason } : {}) },
    };
  },
});
