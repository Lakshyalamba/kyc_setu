import { defaultConfig, type RiskConfig } from './config.js';
import { isValidIsoDate, isoDateEqual, yearsBetween } from './lib/dates.js';
import { nameSimilarity } from './lib/nameSimilarity.js';
import { DOC_KINDS, type DocKind, type RuleContext } from './types.js';

/**
 * A snapshot of the engine's inputs that is safe to store: derived numbers and booleans only.
 * No names, no dates of birth, no document numbers. It is what an officer needs to see why a rule fired.
 */
export function summarizeInputs(ctx: RuleContext, config: RiskConfig = defaultConfig) {
  const name = (k: DocKind) => ctx.extractions[k]?.name?.value;
  const dob = (k: DocKind) => ctx.extractions[k]?.dob?.value;
  const both = <T>(
    a: string | undefined,
    b: string | undefined,
    f: (x: string, y: string) => T,
  ): T | null => (a && b ? f(a, b) : null);

  const ages = [
    ['typed', ctx.personal.dateOfBirth],
    ['PAN', dob('PAN')],
    ['AADHAAR_FRONT', dob('AADHAAR_FRONT')],
  ].flatMap(([source, d]) =>
    d && isValidIsoDate(d) ? [{ source, years: yearsBetween(d, ctx.now) }] : [],
  );

  const docs: Record<string, unknown> = {};
  for (const kind of DOC_KINDS) {
    const e = ctx.extractions[kind];
    if (!e) continue;
    docs[kind] = {
      status: e.status,
      warnings: e.warnings,
      confidence: {
        ...(e.name ? { name: e.name.confidence } : {}),
        ...(e.dob ? { dob: e.dob.confidence } : {}),
        ...(e.panNumber ? { panNumber: e.panNumber.confidence } : {}),
        ...(e.aadhaarNumber ? { aadhaarNumber: e.aadhaarNumber.confidence } : {}),
      },
      ...(e.panNumber ? { panFormatValid: e.panNumber.formatValid } : {}),
      ...(e.aadhaarNumber ? { aadhaarChecksumValid: e.aadhaarNumber.checksumValid } : {}),
    };
  }

  return {
    now: ctx.now.toISOString(),
    nameSimilarity: {
      panVsAadhaar: both(name('PAN'), name('AADHAAR_FRONT'), nameSimilarity),
      formVsPan: both(ctx.personal.fullName, name('PAN'), nameSimilarity),
      threshold: config.thresholds.nameSimilarityMin,
    },
    dob: {
      panEqualsAadhaar: both(dob('PAN'), dob('AADHAAR_FRONT'), isoDateEqual),
      typedEqualsPan: both(ctx.personal.dateOfBirth, dob('PAN'), isoDateEqual),
      typedEqualsAadhaar: both(ctx.personal.dateOfBirth, dob('AADHAAR_FRONT'), isoDateEqual),
      youngestAgeYears: ages.length ? Math.min(...ages.map((a) => a.years)) : null,
    },
    documents: docs,
    comparisons: ctx.comparisons,
    faceMatch: ctx.faceMatch,
    liveness: ctx.liveness,
    priorApproved: {
      count: ctx.priorApprovedMatches.length,
      panMatches: ctx.priorApprovedMatches.filter((m) => m.panMatch).length,
      aadhaarFullMatches: ctx.priorApprovedMatches.filter(
        (m) => m.aadhaarLast4Match && m.aadhaarFullMatch,
      ).length,
    },
  };
}
