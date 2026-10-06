import { describe, expect, it } from 'vitest';
import { build, evaluateRule, failure } from '../../test/builders.js';
import { defaultConfig } from '../config.js';
import { ID, documentQualityPoor } from './document-quality-poor.js';

const rule = documentQualityPoor(defaultConfig);

describe(ID, () => {
  it('uses the configured weight', () =>
    expect(rule).toMatchObject({ id: ID, category: 'quality', weight: 10 }));
  it('passes when no document is low quality', () =>
    expect(evaluateRule(rule, build()).outcome).toEqual({ passed: true }));
  it('fails when any document is LOW_QUALITY and lists them', () => {
    const ctx = build((c) => {
      if (c.extractions.AADHAAR_BACK) c.extractions.AADHAAR_BACK.status = 'LOW_QUALITY';
    });
    const out = failure(rule, ctx);
    expect(out.penalty).toBe(10);
    expect(out.details).toEqual({ documents: ['AADHAAR_BACK'] });
  });
  it('is not applicable when nothing was processed', () => {
    expect(
      evaluateRule(
        rule,
        build((c) => {
          c.extractions = {};
        }),
      ).applicability.applicable,
    ).toBe(false);
  });
});
