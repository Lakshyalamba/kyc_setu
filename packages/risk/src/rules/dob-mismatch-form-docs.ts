import type { RiskConfig } from '../config.js';
import { isValidIsoDate, isoDateEqual } from '../lib/dates.js';
import type { DocKind, Rule } from '../types.js';
import { APPLICABLE, skip } from './helpers.js';

export const ID = 'dob-mismatch-form-docs' as const;
const SOURCES: DocKind[] = ['PAN', 'AADHAAR_FRONT'];

export const dobMismatchFormDocs = (config: RiskConfig): Rule => {
  const docDobs = (ctx: Parameters<Rule['evaluate']>[0]) =>
    SOURCES.flatMap((kind) => {
      const dob = ctx.extractions[kind]?.dob?.value;
      return dob && isValidIsoDate(dob) ? [{ kind, dob }] : [];
    });
  return {
    id: ID,
    category: 'identity',
    weight: config.weights[ID],
    applicableWhen: (ctx) =>
      isValidIsoDate(ctx.personal.dateOfBirth) && docDobs(ctx).length > 0
        ? APPLICABLE
        : skip('No valid typed date of birth, or none extracted from the documents'),
    // Fires when the typed date differs from ANY document's date.
    evaluate: (ctx) => {
      const mismatching = docDobs(ctx)
        .filter((d) => !isoDateEqual(ctx.personal.dateOfBirth, d.dob))
        .map((d) => d.kind);
      return mismatching.length === 0
        ? { passed: true }
        : {
            passed: false,
            penalty: config.weights[ID],
            reason: 'Date of birth typed by the customer differs from the one on a document',
            details: { documents: mismatching },
          };
    },
  };
};
