import type { RiskConfig } from '../config.js';
import { isValidIsoDate, yearsBetween } from '../lib/dates.js';
import type { Rule, RuleContext } from '../types.js';
import { APPLICABLE, skip } from './helpers.js';

export const ID = 'age-ineligible' as const;

export const ageIneligible = (config: RiskConfig): Rule => {
  /** Every valid date of birth we have: typed and from each document. */
  const ages = (ctx: RuleContext) =>
    [
      { source: 'typed', dob: ctx.personal.dateOfBirth },
      { source: 'PAN', dob: ctx.extractions.PAN?.dob?.value },
      { source: 'AADHAAR_FRONT', dob: ctx.extractions.AADHAAR_FRONT?.dob?.value },
    ].flatMap(({ source, dob }) =>
      dob && isValidIsoDate(dob) ? [{ source, years: yearsBetween(dob, ctx.now) }] : [],
    );
  return {
    id: ID,
    category: 'data_integrity',
    weight: config.weights[ID],
    applicableWhen: (ctx) =>
      ages(ctx).length > 0 ? APPLICABLE : skip('No valid date of birth is available'),
    // Uses the youngest age any source implies: if any of them says under 18, that is enough.
    evaluate: (ctx) => {
      const youngest = ages(ctx).reduce((a, b) => (b.years < a.years ? b : a));
      return youngest.years >= config.thresholds.minAgeYears
        ? { passed: true }
        : {
            passed: false,
            penalty: config.weights[ID],
            reason: `The date of birth implies an age under ${config.thresholds.minAgeYears}`,
            details: {
              youngestSource: youngest.source,
              ageYears: youngest.years,
              minimum: config.thresholds.minAgeYears,
            },
          };
    },
  };
};
