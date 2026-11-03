import type { RiskConfig } from '../config.js';
import type { Rule } from '../types.js';
import { APPLICABLE, round4, skip } from './helpers.js';

export const ID = 'face-match-below-threshold' as const;

/** Fires when the face match decided AUTO_FAIL: the selfie does not match the ID photo, or there was no face to compare. */
export const faceMatchBelowThreshold = (config: RiskConfig): Rule => ({
  id: ID,
  category: 'biometric',
  weight: config.weights[ID],
  applicableWhen: (ctx) => (ctx.faceMatch ? APPLICABLE : skip('No face match result is available')),
  evaluate: (ctx) => {
    const f = ctx.faceMatch;
    if (!f || f.decision !== 'AUTO_FAIL') return { passed: true };
    return {
      passed: false,
      penalty: config.weights[ID],
      reason: f.reason
        ? `The selfie could not be compared with the photo on the ID (${f.reason.replaceAll('_', ' ')})`
        : `The selfie does not match the photo on the ID (score ${round4(f.score)}, minimum ${f.thresholds.autoFail})`,
      details: {
        score: round4(f.score),
        threshold: f.thresholds.autoFail,
        ...(f.reason ? { reason: f.reason } : {}),
      },
    };
  },
});
