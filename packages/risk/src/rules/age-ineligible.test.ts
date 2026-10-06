import { describe, expect, it } from 'vitest';
import { build, evaluateRule, failure } from '../../test/builders.js';
import { defaultConfig } from '../config.js';
import { ID, ageIneligible } from './age-ineligible.js';

const rule = ageIneligible(defaultConfig);

describe(ID, () => {
  it('uses the configured weight', () =>
    expect(rule).toMatchObject({ id: ID, category: 'data_integrity', weight: 100 }));
  it('passes for an adult', () =>
    expect(evaluateRule(rule, build()).outcome).toEqual({ passed: true }));

  it('fails for under 18, using the youngest date any source implies', () => {
    const ctx = build((c) => {
      if (c.extractions.AADHAAR_FRONT?.dob) c.extractions.AADHAAR_FRONT.dob.value = '2010-03-01'; // 16 on the fixed "now"
    });
    const out = failure(rule, ctx);
    expect(out.penalty).toBe(100);
    expect(out.details).toEqual({ youngestSource: 'AADHAAR_FRONT', ageYears: 16, minimum: 18 });
  });

  it('is exact on the 18th birthday', () => {
    expect(
      evaluateRule(
        rule,
        build((c) => {
          c.personal.dateOfBirth = '2008-10-10';
        }),
      ).outcome,
    ).toEqual({ passed: true }); // turns 18 today
    expect(
      evaluateRule(
        rule,
        build((c) => {
          c.personal.dateOfBirth = '2008-10-11';
        }),
      ).outcome?.passed,
    ).toBe(false); // tomorrow
  });

  it('is not applicable when there is no valid date of birth anywhere', () => {
    const ctx = build((c) => {
      c.personal.dateOfBirth = 'garbage';
      delete c.extractions.PAN?.dob;
      delete c.extractions.AADHAAR_FRONT?.dob;
    });
    expect(evaluateRule(rule, ctx).applicability.applicable).toBe(false);
  });
});
