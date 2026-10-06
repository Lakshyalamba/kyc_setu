import { describe, expect, it } from 'vitest';
import { build, evaluateRule, failure } from '../../test/builders.js';
import { defaultConfig } from '../config.js';
import { ID, nameMismatchFormPan } from './name-mismatch-form-pan.js';

const rule = nameMismatchFormPan(defaultConfig);

describe(ID, () => {
  it('uses the configured weight', () =>
    expect(rule).toMatchObject({ id: ID, category: 'identity', weight: 15 }));

  it('passes when the typed name matches the PAN name', () => {
    expect(evaluateRule(rule, build()).outcome).toEqual({ passed: true });
    expect(
      evaluateRule(
        rule,
        build((c) => {
          c.personal.fullName = 'rahul  kumar sharma';
        }),
      ).outcome,
    ).toEqual({ passed: true });
  });

  it('fails for a typo large enough to drop below the threshold', () => {
    const out = failure(
      rule,
      build((c) => {
        c.personal.fullName = 'Raul Kumr Sarma';
      }),
    );
    expect(out.penalty).toBe(15);
    expect(out.details).toMatchObject({ similarity: 0.8333, threshold: 0.85 });
  });

  it('tolerates a one-letter typo', () => {
    expect(
      evaluateRule(
        rule,
        build((c) => {
          c.personal.fullName = 'Rahul Kumr Sharma';
        }),
      ).outcome,
    ).toEqual({ passed: true });
  });

  it('is not applicable without a typed name or a PAN name', () => {
    expect(
      evaluateRule(
        rule,
        build((c) => {
          c.personal.fullName = '  ';
        }),
      ).applicability.applicable,
    ).toBe(false);
    expect(
      evaluateRule(
        rule,
        build((c) => {
          delete c.extractions.PAN;
        }),
      ).applicability.applicable,
    ).toBe(false);
  });
});
