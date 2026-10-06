import { describe, expect, it } from 'vitest';
import { build, evaluateRule, failure } from '../../test/builders.js';
import { defaultConfig } from '../config.js';
import { ID, faceMatchBorderline } from './face-match-borderline.js';

const rule = faceMatchBorderline(defaultConfig);

describe(ID, () => {
  it('uses the configured weight', () =>
    expect(rule).toMatchObject({ id: ID, category: 'biometric', weight: 15 }));
  it('passes for a clear match', () =>
    expect(evaluateRule(rule, build()).outcome).toEqual({ passed: true }));
  it('fires from 0.65 up to (not including) 0.75', () => {
    expect(
      failure(
        rule,
        build((c) => {
          c.faceMatch = { score: 0.65 };
        }),
      ).penalty,
    ).toBe(15);
    expect(
      failure(
        rule,
        build((c) => {
          c.faceMatch = { score: 0.7499 };
        }),
      ).penalty,
    ).toBe(15);
    expect(
      evaluateRule(
        rule,
        build((c) => {
          c.faceMatch = { score: 0.75 };
        }),
      ).outcome,
    ).toEqual({ passed: true });
  });
  it('leaves scores below 0.65 to face-match-below-threshold', () => {
    expect(
      evaluateRule(
        rule,
        build((c) => {
          c.faceMatch = { score: 0.3 };
        }),
      ).outcome,
    ).toEqual({ passed: true });
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
