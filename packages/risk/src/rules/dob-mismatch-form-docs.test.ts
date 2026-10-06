import { describe, expect, it } from 'vitest';
import { build, evaluateRule, failure } from '../../test/builders.js';
import { defaultConfig } from '../config.js';
import { ID, dobMismatchFormDocs } from './dob-mismatch-form-docs.js';

const rule = dobMismatchFormDocs(defaultConfig);

describe(ID, () => {
  it('uses the configured weight', () =>
    expect(rule).toMatchObject({ id: ID, category: 'identity', weight: 15 }));

  it('passes when the typed date equals both documents', () =>
    expect(evaluateRule(rule, build()).outcome).toEqual({ passed: true }));

  it('fails when the typed date differs from EITHER document, and says which', () => {
    const ctx = build((c) => {
      if (c.extractions.AADHAAR_FRONT?.dob) c.extractions.AADHAAR_FRONT.dob.value = '1990-05-16';
    });
    const out = failure(rule, ctx);
    expect(out.penalty).toBe(15);
    expect(out.details).toEqual({ documents: ['AADHAAR_FRONT'] });
  });

  it('works with a single document', () => {
    const ctx = build((c) => {
      delete c.extractions.AADHAAR_FRONT;
      c.personal.dateOfBirth = '1991-01-01';
    });
    expect(failure(rule, ctx).details).toEqual({ documents: ['PAN'] });
  });

  it('is not applicable without a valid typed date or any document date', () => {
    expect(
      evaluateRule(
        rule,
        build((c) => {
          c.personal.dateOfBirth = 'not-a-date';
        }),
      ).applicability.applicable,
    ).toBe(false);
    const none = build((c) => {
      delete c.extractions.PAN?.dob;
      delete c.extractions.AADHAAR_FRONT?.dob;
    });
    expect(evaluateRule(rule, none).applicability.applicable).toBe(false);
  });
});
