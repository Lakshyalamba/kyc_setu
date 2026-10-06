import { describe, expect, it } from 'vitest';
import { build, evaluateRule, failure } from '../../test/builders.js';
import { defaultConfig } from '../config.js';
import { ID, nameMismatchPanAadhaar } from './name-mismatch-pan-aadhaar.js';

const rule = nameMismatchPanAadhaar(defaultConfig);

describe(ID, () => {
  it('uses the configured weight', () =>
    expect(rule).toMatchObject({ id: ID, category: 'identity', weight: 25 }));

  it('passes when the names agree (case, titles and dots do not matter)', () => {
    expect(evaluateRule(rule, build()).outcome).toEqual({ passed: true });
    const decorated = build((c) => {
      if (c.extractions.AADHAAR_FRONT?.name)
        c.extractions.AADHAAR_FRONT.name.value = 'Shri Rahul Kumar Sharma.';
    });
    expect(evaluateRule(rule, decorated).outcome).toEqual({ passed: true });
  });

  it('fails for an abbreviated middle name (plain edit distance does not know "K" means "Kumar")', () => {
    const abbreviated = build((c) => {
      if (c.extractions.AADHAAR_FRONT?.name)
        c.extractions.AADHAAR_FRONT.name.value = 'Shri Rahul K. Sharma';
    });
    expect(evaluateRule(rule, abbreviated).outcome?.passed).toBe(false);
  });

  it('fails for different names, with numbers but no names in the details', () => {
    const ctx = build((c) => {
      if (c.extractions.AADHAAR_FRONT?.name) c.extractions.AADHAAR_FRONT.name.value = 'PRIYA NAIR';
    });
    const out = failure(rule, ctx);
    expect(out.penalty).toBe(25);
    expect(out.details).toMatchObject({ threshold: 0.85 });
    expect(JSON.stringify(out)).not.toMatch(/PRIYA|RAHUL/);
  });

  it('passes right at the threshold boundary but fails just under it', () => {
    // 17 vs 20 characters: similarity exactly 0.85 passes.
    const edge = build((c) => {
      if (c.extractions.PAN?.name) c.extractions.PAN.name.value = 'ABCDEFGHIJKLMNOPQRST';
      if (c.extractions.AADHAAR_FRONT?.name)
        c.extractions.AADHAAR_FRONT.name.value = 'ABCDEFGHIJKLMNOPQXXX';
    });
    expect(evaluateRule(rule, edge).outcome).toEqual({ passed: true });
    const under = build((c) => {
      if (c.extractions.PAN?.name) c.extractions.PAN.name.value = 'ABCDEFGHIJKLMNOPQRST';
      if (c.extractions.AADHAAR_FRONT?.name)
        c.extractions.AADHAAR_FRONT.name.value = 'ABCDEFGHIJKLMNOPXXXX';
    });
    expect(evaluateRule(rule, under).outcome?.passed).toBe(false);
  });

  it('is not applicable when either name is missing', () => {
    const noPan = build((c) => {
      if (c.extractions.PAN) delete c.extractions.PAN.name;
    });
    const noAadhaar = build((c) => {
      delete c.extractions.AADHAAR_FRONT;
    });
    for (const ctx of [noPan, noAadhaar]) {
      expect(evaluateRule(rule, ctx).applicability).toMatchObject({
        applicable: false,
        reason: expect.any(String),
      });
    }
  });
});
