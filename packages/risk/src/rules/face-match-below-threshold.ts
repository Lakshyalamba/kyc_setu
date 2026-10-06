import type { RiskConfig } from '../config.js';
import type { Rule } from '../types.js';
import { APPLICABLE, round4, skip } from './helpers.js';

export const ID = 'face-match-below-threshold' as const;

export const faceMatchBelowThreshold = (config: RiskConfig): Rule => ({
  id: ID,
  category: 'biometric',
  weight: config.weights[ID],
  applicableWhen: (ctx) => (ctx.faceMatch ? APPLICABLE : skip('No face match result is available')),
  evaluate: (ctx) => {
    const score = ctx.faceMatch?.score ?? 0;
    const threshold = config.thresholds.faceMatchMin;
    return score >= threshold
      ? { passed: true }
      : {
          passed: false,
          penalty: config.weights[ID],
          reason: `The selfie does not match the photo on the ID (score ${round4(score)}, minimum ${threshold})`,
          details: { score: round4(score), threshold },
        };
  },
});
