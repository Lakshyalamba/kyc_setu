import { describe, expect, it } from 'vitest';
import { build, evaluateRule, failure } from '../../test/builders.js';
import { defaultConfig } from '../config.js';
import { ID, lowOcrConfidence } from './low-ocr-confidence.js';

const rule = lowOcrConfidence(defaultConfig);

describe(ID, () => {
  it('uses the configured weight', () =>
    expect(rule).toMatchObject({ id: ID, category: 'quality', weight: 10 }));
  it('passes when every critical field is read confidently', () =>
    expect(evaluateRule(rule, build()).outcome).toEqual({ passed: true }));

  it('fails if ANY critical field is below 0.6, and names the fields', () => {
    const ctx = build((c) => {
      if (c.extractions.PAN?.name) c.extractions.PAN.name.confidence = 0.59;
      if (c.extractions.AADHAAR_FRONT?.aadhaarNumber)
        c.extractions.AADHAAR_FRONT.aadhaarNumber.confidence = 0.4;
    });
    const out = failure(rule, ctx);
    expect(out.penalty).toBe(10);
    expect(out.details).toEqual({
      fields: ['PAN.name', 'AADHAAR_FRONT.aadhaarNumber'],
      lowestConfidence: 0.4,
    });
  });

  it('treats exactly 0.6 as acceptable', () => {
    const ctx = build((c) => {
      if (c.extractions.PAN?.name) c.extractions.PAN.name.confidence = 0.6;
    });
    expect(evaluateRule(rule, ctx).outcome).toEqual({ passed: true });
  });

  it('is not applicable when no critical field was read at all', () => {
    const ctx = build((c) => {
      c.extractions = { PAN: { status: 'LOW_QUALITY', warnings: [] } };
    });
    expect(evaluateRule(rule, ctx).applicability.applicable).toBe(false);
  });
});
