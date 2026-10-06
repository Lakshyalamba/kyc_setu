import type { RiskConfig } from '../config.js';
import { DOC_KINDS, type Rule } from '../types.js';
import { APPLICABLE, skip } from './helpers.js';

export const ID = 'extraction-unusable' as const;
const UNUSABLE = new Set(['WRONG_DOCUMENT', 'PARSE_FAILED', 'ERROR']);

/**
 * Skipped is not passed. If a document could not be read at all, most identity rules above are skipped
 * and would leave a clean-looking score. This rule makes that visible instead.
 */
export const extractionUnusable = (config: RiskConfig): Rule => ({
  id: ID,
  category: 'data_integrity',
  weight: config.weights[ID],
  applicableWhen: (ctx) =>
    DOC_KINDS.some((k) => ctx.extractions[k]) ? APPLICABLE : skip('No document was processed'),
  evaluate: (ctx) => {
    const bad = DOC_KINDS.flatMap((k) => {
      const status = ctx.extractions[k]?.status;
      return status && UNUSABLE.has(status) ? [[k, status] as const] : [];
    });
    return bad.length === 0
      ? { passed: true }
      : {
          passed: false,
          penalty: config.weights[ID],
          reason: `${bad.length} document(s) could not be used (wrong document, unreadable, or processing failed)`,
          details: { documents: Object.fromEntries(bad) },
        };
  },
});
