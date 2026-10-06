import type { RiskConfig } from '../config.js';
import type { Rule } from '../types.js';
import { APPLICABLE, round4, skip } from './helpers.js';

export const ID = 'face-match-borderline' as const;

export const faceMatchBorderline = (config: RiskConfig): Rule => ({
  id: ID,
  category: 'biometric',
  weight: config.weights[ID],
  applicableWhen: (ctx) => (ctx.faceMatch ? APPLICABLE : skip('No face match result is available')),
  // [faceMatchMin, faceMatchBorderlineMax). Below the lower bound is face-match-below-threshold's job.
  evaluate: (ctx) => {
    const score = ctx.faceMatch?.score ?? 0;
    const { faceMatchMin: low, faceMatchBorderlineMax: high } = config.thresholds;
    return score >= low && score < high
      ? {
          passed: false,
          penalty: config.weights[ID],
          reason: `The selfie only borderline matches the photo on the ID (score ${round4(score)}); a human look is recommended`,
          details: { score: round4(score), range: [low, high] },
        }
      : { passed: true };
  },
});
