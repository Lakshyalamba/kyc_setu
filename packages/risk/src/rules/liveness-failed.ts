import type { RiskConfig } from '../config.js';
import type { Rule } from '../types.js';
import { APPLICABLE, skip } from './helpers.js';

export const ID = 'liveness-failed' as const;

export const livenessFailed = (config: RiskConfig): Rule => ({
  id: ID,
  category: 'biometric',
  weight: config.weights[ID],
  applicableWhen: (ctx) => (ctx.liveness ? APPLICABLE : skip('No liveness result is available')),
  evaluate: (ctx) =>
    ctx.liveness?.passed
      ? { passed: true }
      : {
          passed: false,
          penalty: config.weights[ID],
          reason: 'The liveness (motion) check failed',
        },
});
