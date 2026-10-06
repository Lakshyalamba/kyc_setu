import { describe, expect, it } from 'vitest';
import { build, evaluateRule, failure } from '../../test/builders.js';
import { defaultConfig } from '../config.js';
import { ID, dobMismatchPanAadhaar } from './dob-mismatch-pan-aadhaar.js';

const rule = dobMismatchPanAadhaar(defaultConfig);

describe(ID, () => {
  it('uses the configured weight', () =>
    expect(rule).toMatchObject({ id: ID, category: 'identity', weight: 20 }));

  it('passes when both documents show the same day', () =>
    expect(evaluateRule(rule, build()).outcome).toEqual({ passed: true }));

  it('fails when the days differ, even by one (exact day match is required)', () => {
    const ctx = build((c) => {
      if (c.extractions.AADHAAR_FRONT?.dob) c.extractions.AADHAAR_FRONT.dob.value = '1990-05-16';
    });
    expect(failure(rule, ctx).penalty).toBe(20);
  });

  it('is not applicable when a date is missing or not a real date', () => {
    expect(
      evaluateRule(
        rule,
        build((c) => {
          delete c.extractions.PAN?.dob;
        }),
      ).applicability.applicable,
    ).toBe(false);
    const bad = build((c) => {
      if (c.extractions.PAN?.dob) c.extractions.PAN.dob.value = '1990-02-31';
    });
    expect(evaluateRule(rule, bad).applicability).toMatchObject({ applicable: false });
  });
});
