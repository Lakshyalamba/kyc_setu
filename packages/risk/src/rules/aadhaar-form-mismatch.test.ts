import { describe, expect, it } from 'vitest';
import { build, evaluateRule, failure } from '../../test/builders.js';
import { defaultConfig } from '../config.js';
import { ID, aadhaarFormMismatch } from './aadhaar-form-mismatch.js';

const rule = aadhaarFormMismatch(defaultConfig);

describe(ID, () => {
  it('uses the configured weight', () =>
    expect(rule).toMatchObject({ id: ID, category: 'identity', weight: 20 }));
  it('passes when the typed Aadhaar matches the extracted one', () =>
    expect(evaluateRule(rule, build()).outcome).toEqual({ passed: true }));
  it('fails when it does not', () => {
    expect(
      failure(
        rule,
        build((c) => {
          c.comparisons.aadhaarTypedMatchesExtracted = false;
        }),
      ).penalty,
    ).toBe(20);
  });
  it('is not applicable when the two could not be compared', () => {
    expect(
      evaluateRule(
        rule,
        build((c) => {
          c.comparisons.aadhaarTypedMatchesExtracted = null;
        }),
      ).applicability.applicable,
    ).toBe(false);
  });
});
