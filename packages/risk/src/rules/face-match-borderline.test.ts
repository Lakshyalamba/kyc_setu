import { describe, expect, it } from 'vitest';
import { build, evaluateRule, face, failure } from '../../test/builders.js';
import { defaultConfig } from '../config.js';
import { ID, faceMatchBorderline } from './face-match-borderline.js';

const rule = faceMatchBorderline(defaultConfig);
const at = (score: number) =>
  build((c) => {
    c.faceMatch = face(score);
  });

describe(ID, () => {
  it('uses the configured weight', () =>
    expect(rule).toMatchObject({ id: ID, category: 'biometric', weight: 15 }));
  it('passes for a good match', () =>
    expect(evaluateRule(rule, build()).outcome).toEqual({ passed: true }));

  it('fires for the REVIEW band: from the fail boundary up to, not including, the pass boundary', () => {
    expect(failure(rule, at(0.3)).details).toEqual({ score: 0.3, range: [0.3, 0.5] });
    expect(evaluateRule(rule, at(0.4999)).outcome?.passed).toBe(false);
    expect(evaluateRule(rule, at(0.5)).outcome).toEqual({ passed: true });
  });

  it('leaves a clear failure to face-match-below-threshold', () => {
    expect(evaluateRule(rule, at(0.2999)).outcome).toEqual({ passed: true });
    expect(evaluateRule(rule, at(0)).outcome).toEqual({ passed: true });
  });

  it('is not applicable without a face match result', () => {
    expect(
      evaluateRule(
        rule,
        build((c) => {
          c.faceMatch = null;
        }),
      ).applicability.applicable,
    ).toBe(false);
  });
});
