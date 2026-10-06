import type { RiskConfig } from '../config.js';
import { nameSimilarity } from '../lib/nameSimilarity.js';
import type { Rule } from '../types.js';
import { APPLICABLE, skip } from './helpers.js';

export const ID = 'name-mismatch-pan-aadhaar' as const;

export const nameMismatchPanAadhaar = (config: RiskConfig): Rule => ({
  id: ID,
  category: 'identity',
  weight: config.weights[ID],
  applicableWhen: (ctx) =>
    ctx.extractions.PAN?.name && ctx.extractions.AADHAAR_FRONT?.name
      ? APPLICABLE
      : skip('The name was not extracted from both the PAN and the Aadhaar'),
  evaluate: (ctx) => {
    const similarity = nameSimilarity(
      ctx.extractions.PAN?.name?.value ?? '',
      ctx.extractions.AADHAAR_FRONT?.name?.value ?? '',
    );
    const threshold = config.thresholds.nameSimilarityMin;
    return similarity >= threshold
      ? { passed: true }
      : {
          passed: false,
          penalty: config.weights[ID],
          reason: `Name on the PAN and on the Aadhaar differ (similarity ${similarity}, minimum ${threshold})`,
          details: { similarity, threshold },
        };
  },
});
