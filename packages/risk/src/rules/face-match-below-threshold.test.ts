import { describe, expect, it } from 'vitest';
import { build, evaluateRule, failure } from '../../test/builders.js';
import { defaultConfig } from '../config.js';
import { ID, faceMatchBelowThreshold } from './face-match-below-threshold.js';

const rule = faceMatchBelowThreshold(defaultConfig);

describe(ID, () => {
  it('uses the configured weight', () =>
    expect(rule).toMatchObject({ id: ID, category: 'biometric', weight: 35 }));
  it('passes for a good match', () =>
    expect(evaluateRule(rule, build()).outcome).toEqual({ passed: true }));
  it('fails below 0.65', () => {
    const out = failure(
      rule,
      build((c) => {
        c.faceMatch = { score: 0.4 };
      }),
    );
    expect(out.penalty).toBe(35);
    expect(out.details).toEqual({ score: 0.4, threshold: 0.65 });
  });
  it('passes at exactly 0.65 and fails just under', () => {
    expect(
      evaluateRule(
        rule,
        build((c) => {
          c.faceMatch = { score: 0.65 };
        }),
      ).outcome,
    ).toEqual({ passed: true });
    expect(
      evaluateRule(
        rule,
        build((c) => {
          c.faceMatch = { score: 0.6499 };
        }),
      ).outcome?.passed,
    ).toBe(false);
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
