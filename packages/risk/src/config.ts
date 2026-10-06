/**
 * EVERY tunable lives in this file: weights, thresholds, the band table and the band floors.
 * Rule files read from here and contain no numbers of their own.
 *
 * Changing anything here changes the engine fingerprint, which makes `test/version-lock.test.ts` fail
 * until ENGINE_VERSION is bumped, so historical scores stay explainable.
 */
import type { Band } from './types.js';

export const RULE_IDS = [
  'name-mismatch-pan-aadhaar',
  'name-mismatch-form-pan',
  'dob-mismatch-pan-aadhaar',
  'dob-mismatch-form-docs',
  'pan-format-invalid',
  'aadhaar-checksum-invalid',
  'pan-form-mismatch',
  'aadhaar-form-mismatch',
  'low-ocr-confidence',
  'document-quality-poor',
  'face-match-below-threshold',
  'face-match-borderline',
  'liveness-failed',
  'duplicate-pan-approved',
  'duplicate-aadhaar-approved',
  'age-ineligible',
  'extraction-unusable',
] as const;
export type RuleId = (typeof RULE_IDS)[number];

/** Not a rule in the list above: the engine adds it when a rule throws instead of letting it crash. */
export const META_RULE_EVALUATION_ERROR = 'rule-evaluation-error' as const;

export interface RiskConfig {
  weights: Record<RuleId | typeof META_RULE_EVALUATION_ERROR, number>;
  thresholds: {
    /** Name rules fire when the similarity (0-1) is below this. */
    nameSimilarityMin: number;
    /** low-ocr-confidence fires when a critical field is read with less confidence than this. */
    criticalFieldConfidenceMin: number;
    /** face-match-below-threshold fires below this score. */
    faceMatchMin: number;
    /** face-match-borderline fires from faceMatchMin up to (but not including) this score. */
    faceMatchBorderlineMax: number;
    minAgeYears: number;
  };
  /** Fields whose OCR confidence matters. */
  criticalFields: readonly ('name' | 'dob' | 'panNumber' | 'aadhaarNumber')[];
  /** Inclusive score ranges. They must cover 0-100 without gaps. */
  bands: Record<Band, readonly [number, number]>;
  /** When one of these rules fires the final band is at least the given one, whatever the score. */
  bandFloors: Partial<Record<RuleId, Band>>;
  /** Rules that set `hardFail` (and force HIGH). */
  hardFailRules: readonly RuleId[];
}

export const defaultConfig: RiskConfig = {
  weights: {
    'name-mismatch-pan-aadhaar': 25,
    'name-mismatch-form-pan': 15,
    'dob-mismatch-pan-aadhaar': 20,
    'dob-mismatch-form-docs': 15,
    'pan-format-invalid': 15,
    'aadhaar-checksum-invalid': 20,
    'pan-form-mismatch': 20,
    'aadhaar-form-mismatch': 20,
    'low-ocr-confidence': 10,
    'document-quality-poor': 10,
    'face-match-below-threshold': 35,
    'face-match-borderline': 15,
    'liveness-failed': 25,
    'duplicate-pan-approved': 40,
    'duplicate-aadhaar-approved': 40,
    'age-ineligible': 100,
    'extraction-unusable': 30,
    'rule-evaluation-error': 20,
  },
  thresholds: {
    nameSimilarityMin: 0.85,
    criticalFieldConfidenceMin: 0.6,
    faceMatchMin: 0.65,
    faceMatchBorderlineMax: 0.75,
    minAgeYears: 18,
  },
  criticalFields: ['name', 'dob', 'panNumber', 'aadhaarNumber'],
  // LOW is 0-14 (not 0-20) so that a single identity mismatch or the soft face flag reaches MEDIUM.
  bands: { LOW: [0, 14], MEDIUM: [15, 55], HIGH: [56, 100] },
  bandFloors: {
    'face-match-below-threshold': 'HIGH',
    'duplicate-pan-approved': 'HIGH',
    'duplicate-aadhaar-approved': 'HIGH',
    'age-ineligible': 'HIGH',
  },
  hardFailRules: ['age-ineligible'],
};
