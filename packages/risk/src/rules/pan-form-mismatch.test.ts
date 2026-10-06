import { describe, expect, it } from 'vitest';
import { build, evaluateRule, failure } from '../../test/builders.js';
import { defaultConfig } from '../config.js';
import { ID, panFormMismatch } from './pan-form-mismatch.js';

const rule = panFormMismatch(defaultConfig);

describe(ID, () => {
  it('uses the configured weight', () =>
    expect(rule).toMatchObject({ id: ID, category: 'identity', weight: 20 }));
  it('passes when the typed PAN matches the extracted one', () =>
    expect(evaluateRule(rule, build()).outcome).toEqual({ passed: true }));
  it('fails when it does not', () => {
    expect(
      failure(
        rule,
        build((c) => {
          c.comparisons.panTypedMatchesExtracted = false;
        }),
      ).penalty,
    ).toBe(20);
  });
  it('is not applicable when the two could not be compared', () => {
    const r = evaluateRule(
      rule,
      build((c) => {
        c.comparisons.panTypedMatchesExtracted = null;
      }),
    );
    expect(r.applicability).toMatchObject({ applicable: false });
    expect(r.outcome).toBeNull();
  });
});
