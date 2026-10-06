/**
 * The risk engine's data model. Everything here is plain data: no Prisma types, no I/O.
 *
 * PII rule: the engine may see names and dates of birth (it has to compare them), but it never sees a
 * full PAN or Aadhaar number. Comparisons that need those (typed vs extracted, duplicates) are done by
 * the worker, which already decrypts, and handed to the engine as booleans.
 */

export type DocKind = 'PAN' | 'AADHAAR_FRONT' | 'AADHAAR_BACK';
export const DOC_KINDS: readonly DocKind[] = ['PAN', 'AADHAAR_FRONT', 'AADHAAR_BACK'];

export type ExtractionState =
  'PENDING' | 'OK' | 'LOW_QUALITY' | 'PARSE_FAILED' | 'WRONG_DOCUMENT' | 'ERROR' | 'SKIPPED';

export interface ValueFact {
  value: string;
  confidence: number;
}

export interface ExtractionFacts {
  status: ExtractionState;
  name?: ValueFact;
  /** ISO date (YYYY-MM-DD). */
  dob?: ValueFact;
  /** The PAN itself is not passed in: only whether it is well-formed and how sure the OCR was. */
  panNumber?: { confidence: number; formatValid: boolean };
  /** The (masked) Aadhaar is not passed in: only whether its Verhoeff checksum held, and OCR confidence. */
  aadhaarNumber?: { confidence: number; checksumValid: boolean };
  /** Parser/quality warning codes, e.g. "LOW_SHARPNESS". */
  warnings: string[];
}

export interface FaceMatchFacts {
  /** Similarity between the selfie and the ID photo, 0..1. */
  score: number;
}

export interface LivenessFacts {
  passed: boolean;
}

/** One APPROVED session of a *different* user, already compared with this session by the worker. */
export interface PriorApprovedMatch {
  userId: string;
  sessionId: string;
  panMatch: boolean;
  aadhaarLast4Match: boolean;
  aadhaarFullMatch: boolean;
}

export interface RuleContext {
  /** Injected so evaluation is a pure function of its inputs. */
  now: Date;
  session: { id: string; userId: string };
  /** What the customer typed. */
  personal: { fullName: string; /** ISO date */ dateOfBirth: string };
  extractions: Partial<Record<DocKind, ExtractionFacts>>;
  comparisons: {
    /** null = could not be compared (e.g. nothing was extracted). */
    panTypedMatchesExtracted: boolean | null;
    aadhaarTypedMatchesExtracted: boolean | null;
  };
  faceMatch: FaceMatchFacts | null;
  liveness: LivenessFacts | null;
  priorApprovedMatches: PriorApprovedMatch[];
}

/** What callers pass to `runRiskEngine`: `now` is optional there and defaults to the current time. */
export type RuleInput = Omit<RuleContext, 'now'> & { now?: Date };

export type RuleCategory = 'identity' | 'quality' | 'biometric' | 'duplicate' | 'data_integrity';

export type Applicability = { applicable: true } | { applicable: false; reason: string };

export type RuleOutcome =
  | { passed: true }
  | { passed: false; penalty: number; reason: string; details?: Record<string, unknown> };

export interface Rule {
  /** Stable kebab-case id. Used in audit rows, the UI and the config. */
  id: string;
  category: RuleCategory;
  /** The most this rule can add to the score. */
  weight: number;
  applicableWhen(ctx: RuleContext): Applicability;
  evaluate(ctx: RuleContext): RuleOutcome;
}

export type Band = 'LOW' | 'MEDIUM' | 'HIGH';

export interface TriggeredRule {
  ruleId: string;
  category: RuleCategory;
  penalty: number;
  reason: string;
  details?: Record<string, unknown>;
}

export interface RiskResult {
  /** 0-100, higher is riskier. */
  score: number;
  /** Final band: the score's band, raised by any band floors. */
  band: Band;
  /** The band the score alone would give. */
  rawBand: Band;
  /** A hard-fail rule fired (e.g. under 18): the band is HIGH whatever the score. */
  hardFail: boolean;
  /** Rules that fired, in evaluation order (sorted by rule id). */
  triggeredRules: TriggeredRule[];
  /** Rules whose firing raised the band to at least `band`. */
  bandFloors: Array<{ ruleId: string; band: Band }>;
  /** Every rule that ran, in evaluation order. */
  appliedRules: string[];
  /** Rules that did not apply, and why. */
  skippedRules: Array<{ ruleId: string; reason: string }>;
  engineVersion: string;
}
