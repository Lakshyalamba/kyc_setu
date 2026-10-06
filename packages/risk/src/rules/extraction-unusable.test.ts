import { describe, expect, it } from 'vitest';
import { build, evaluateRule, failure } from '../../test/builders.js';
import { defaultConfig } from '../config.js';
import { ID, extractionUnusable } from './extraction-unusable.js';

const rule = extractionUnusable(defaultConfig);

describe(ID, () => {
  it('uses the configured weight', () =>
    expect(rule).toMatchObject({ id: ID, category: 'data_integrity', weight: 30 }));
  it('passes when every document was read (LOW_QUALITY counts: document-quality-poor covers it)', () => {
    expect(evaluateRule(rule, build()).outcome).toEqual({ passed: true });
    expect(
      evaluateRule(
        rule,
        build((c) => {
          if (c.extractions.PAN) c.extractions.PAN.status = 'LOW_QUALITY';
        }),
      ).outcome,
    ).toEqual({ passed: true });
  });
  it.each(['WRONG_DOCUMENT', 'PARSE_FAILED', 'ERROR'] as const)(
    'fails when a document is %s',
    (status) => {
      const out = failure(
        rule,
        build((c) => {
          if (c.extractions.AADHAAR_FRONT) c.extractions.AADHAAR_FRONT.status = status;
        }),
      );
      expect(out.penalty).toBe(30);
      expect(out.details).toEqual({ documents: { AADHAAR_FRONT: status } });
    },
  );
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
