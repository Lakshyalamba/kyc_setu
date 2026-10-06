import type { RiskConfig } from '../config.js';
import { nameSimilarity } from '../lib/nameSimilarity.js';
import type { Rule } from '../types.js';
import { APPLICABLE, skip } from './helpers.js';

export const ID = 'name-mismatch-form-pan' as const;

export const nameMismatchFormPan = (config: RiskConfig): Rule => ({
  id: ID,
  category: 'identity',
  weight: config.weights[ID],
  applicableWhen: (ctx) =>
    ctx.personal.fullName.trim() && ctx.extractions.PAN?.name
      ? APPLICABLE
      : skip('No typed name, or the name was not extracted from the PAN'),
  evaluate: (ctx) => {
    const similarity = nameSimilarity(
      ctx.personal.fullName,
      ctx.extractions.PAN?.name?.value ?? '',
    );
    const threshold = config.thresholds.nameSimilarityMin;
    return similarity >= threshold
      ? { passed: true }
      : {
          passed: false,
          penalty: config.weights[ID],
          reason: `Name typed by the customer and name on the PAN differ (similarity ${similarity}, minimum ${threshold})`,
          details: { similarity, threshold },
        };
  },
});
