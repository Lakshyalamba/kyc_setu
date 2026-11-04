import type { RiskConfig } from '../config.js';
import type { Rule } from '../types.js';
import { APPLICABLE, skip } from './helpers.js';

export const ID = 'liveness-pad-borderline' as const;

/**
 * Fires when the passive anti-spoofing model counted and its score was close to the line: the selfie passed, but "looked
 * spoof-ish", so an officer should eyeball it. Not applicable when the model did not decide (the shadow setting, a selfie
 * from before it existed, a file upload) or could not judge the picture.
 */
export const livenessPadBorderline = (config: RiskConfig): Rule => ({
  id: ID,
  category: 'biometric',
  weight: config.weights[ID],
  applicableWhen: (ctx) => {
    const l = ctx.liveness;
    if (!l) return skip('No selfie has been taken');
    if (l.method === 'NONE') return skip('No anti-spoofing check was performed (file upload)');
    if (l.checkMethod !== 'PASSIVE_PAD' && l.checkMethod !== 'PASSIVE_PLUS_MOTION')
      return skip('The passive anti-spoofing model did not decide this selfie');
    if (!l.padDecision || l.padDecision === 'UNAVAILABLE')
      return skip('The anti-spoofing model could not judge this picture');
    return APPLICABLE;
  },
  evaluate: (ctx) => {
    const l = ctx.liveness;
    if (l?.padDecision !== 'BORDERLINE') return { passed: true };
    return {
      passed: false,
      penalty: config.weights[ID],
      reason: `The anti-spoofing score was close to the line${typeof l.padScore === 'number' ? ` (${l.padScore.toFixed(2)})` : ''}: an officer should look at the selfie`,
      details: {
        padDecision: 'BORDERLINE',
        ...(typeof l.padScore === 'number' ? { padScore: l.padScore } : {}),
      },
    };
  },
});
