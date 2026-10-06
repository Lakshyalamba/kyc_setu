import { describe, expect, it } from 'vitest';
import { build, evaluateRule, failure } from '../../test/builders.js';
import { defaultConfig } from '../config.js';
import { ID, panFormatInvalid } from './pan-format-invalid.js';

const rule = panFormatInvalid(defaultConfig);

describe(ID, () => {
  it('uses the configured weight', () =>
    expect(rule).toMatchObject({ id: ID, category: 'data_integrity', weight: 15 }));
  it('passes for a well-formed PAN', () =>
    expect(evaluateRule(rule, build()).outcome).toEqual({ passed: true }));
  it('fails for a malformed PAN', () => {
    const ctx = build((c) => {
      if (c.extractions.PAN?.panNumber) c.extractions.PAN.panNumber.formatValid = false;
    });
    expect(failure(rule, ctx).penalty).toBe(15);
  });
  it('is not applicable when no PAN number was extracted', () => {
    expect(
      evaluateRule(
        rule,
        build((c) => {
          delete c.extractions.PAN?.panNumber;
        }),
      ).applicability.applicable,
    ).toBe(false);
  });
});
