import { defaultConfig, type RiskConfig } from '../config.js';
import type { Rule } from '../types.js';
import { aadhaarChecksumInvalid } from './aadhaar-checksum-invalid.js';
import { aadhaarFormMismatch } from './aadhaar-form-mismatch.js';
import { ageIneligible } from './age-ineligible.js';
import { dobMismatchFormDocs } from './dob-mismatch-form-docs.js';
import { dobMismatchPanAadhaar } from './dob-mismatch-pan-aadhaar.js';
import { documentQualityPoor } from './document-quality-poor.js';
import { duplicateAadhaarApproved } from './duplicate-aadhaar-approved.js';
import { duplicatePanApproved } from './duplicate-pan-approved.js';
import { extractionUnusable } from './extraction-unusable.js';
import { faceMatchBelowThreshold } from './face-match-below-threshold.js';
import { faceMatchBorderline } from './face-match-borderline.js';
import { livenessFailed } from './liveness-failed.js';
import { lowOcrConfidence } from './low-ocr-confidence.js';
import { nameMismatchFormPan } from './name-mismatch-form-pan.js';
import { nameMismatchPanAadhaar } from './name-mismatch-pan-aadhaar.js';
import { panFormMismatch } from './pan-form-mismatch.js';
import { panFormatInvalid } from './pan-format-invalid.js';

/** The full MVP rule set, built from a config (so weights and thresholds can be tuned in one place). */
export function createRules(config: RiskConfig = defaultConfig): Rule[] {
  return [
    nameMismatchPanAadhaar,
    nameMismatchFormPan,
    dobMismatchPanAadhaar,
    dobMismatchFormDocs,
    panFormatInvalid,
    aadhaarChecksumInvalid,
    panFormMismatch,
    aadhaarFormMismatch,
    lowOcrConfidence,
    documentQualityPoor,
    faceMatchBelowThreshold,
    faceMatchBorderline,
    livenessFailed,
    duplicatePanApproved,
    duplicateAadhaarApproved,
    ageIneligible,
    extractionUnusable,
  ].map((make) => make(config));
}
