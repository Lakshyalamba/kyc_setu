import type { RiskConfig } from '../config.js';
import { DOC_KINDS, type Rule } from '../types.js';
import { APPLICABLE, skip } from './helpers.js';

export const ID = 'document-quality-poor' as const;

export const documentQualityPoor = (config: RiskConfig): Rule => ({
  id: ID,
  category: 'quality',
  weight: config.weights[ID],
  applicableWhen: (ctx) =>
    DOC_KINDS.some((k) => ctx.extractions[k]) ? APPLICABLE : skip('No document was processed'),
  evaluate: (ctx) => {
    const poor = DOC_KINDS.filter((k) => ctx.extractions[k]?.status === 'LOW_QUALITY');
    return poor.length === 0
      ? { passed: true }
      : {
          passed: false,
          penalty: config.weights[ID],
          reason: `${poor.length} document(s) were too blurry or small to read`,
          details: { documents: poor },
        };
  },
});
