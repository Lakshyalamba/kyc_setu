import { describe, expect, it } from 'vitest';
import { build, evaluateRule, failure } from '../../test/builders.js';
import { defaultConfig } from '../config.js';
import { ID, aadhaarChecksumInvalid } from './aadhaar-checksum-invalid.js';

const rule = aadhaarChecksumInvalid(defaultConfig);

describe(ID, () => {
  it('uses the configured weight', () =>
    expect(rule).toMatchObject({ id: ID, category: 'data_integrity', weight: 20 }));
  it('passes when the Verhoeff checksum held', () =>
    expect(evaluateRule(rule, build()).outcome).toEqual({ passed: true }));
  it('fails when it did not', () => {
    const ctx = build((c) => {
      if (c.extractions.AADHAAR_FRONT?.aadhaarNumber)
        c.extractions.AADHAAR_FRONT.aadhaarNumber.checksumValid = false;
    });
    expect(failure(rule, ctx).penalty).toBe(20);
  });
  it('is not applicable when no Aadhaar number was extracted', () => {
    expect(
      evaluateRule(
        rule,
        build((c) => {
          delete c.extractions.AADHAAR_FRONT?.aadhaarNumber;
        }),
      ).applicability.applicable,
    ).toBe(false);
  });
});
