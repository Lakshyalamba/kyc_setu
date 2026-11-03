import type { RiskConfig } from '../config.js';
import type { Rule } from '../types.js';
import { APPLICABLE, round4, skip } from './helpers.js';

export const ID = 'face-match-borderline' as const;

/** Fires when the face match decided REVIEW: not clearly the same face, not clearly different. A person should look. */
export const faceMatchBorderline = (config: RiskConfig): Rule => ({
  id: ID,
  category: 'biometric',
  weight: config.weights[ID],
  applicableWhen: (ctx) => (ctx.faceMatch ? APPLICABLE : skip('No face match result is available')),
  evaluate: (ctx) => {
    const f = ctx.faceMatch;
    if (!f || f.decision !== 'REVIEW') return { passed: true };
    return {
      passed: false,
      penalty: config.weights[ID],
      reason: `The selfie only borderline matches the photo on the ID (score ${round4(f.score)}); a human look is recommended`,
      details: { score: round4(f.score), range: [f.thresholds.autoFail, f.thresholds.autoPass] },
    };
  },
});
