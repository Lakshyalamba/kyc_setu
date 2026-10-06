import { describe, expect, it } from 'vitest';
import { build, evaluateRule, failure } from '../../test/builders.js';
import { defaultConfig } from '../config.js';
import { ID, livenessFailed } from './liveness-failed.js';

const rule = livenessFailed(defaultConfig);

describe(ID, () => {
  it('uses the configured weight', () =>
    expect(rule).toMatchObject({ id: ID, category: 'biometric', weight: 25 }));
  it('passes when liveness passed', () =>
    expect(evaluateRule(rule, build()).outcome).toEqual({ passed: true }));
  it('fails when it did not', () => {
    expect(
      failure(
        rule,
        build((c) => {
          c.liveness = { passed: false };
        }),
      ).penalty,
    ).toBe(25);
  });
  it('is not applicable without a liveness result', () => {
    expect(
      evaluateRule(
        rule,
        build((c) => {
          c.liveness = null;
        }),
      ).applicability.applicable,
    ).toBe(false);
  });
});
