import type { RiskConfig } from '../config.js';
import { DOC_KINDS, type Rule, type RuleContext } from '../types.js';
import { APPLICABLE, round4, skip } from './helpers.js';

export const ID = 'low-ocr-confidence' as const;

export const lowOcrConfidence = (config: RiskConfig): Rule => {
  /** [doc, field, confidence] for every critical field that was read, in a fixed order. */
  const readings = (ctx: RuleContext) =>
    DOC_KINDS.flatMap((kind) =>
      config.criticalFields.flatMap((field) => {
        const c = ctx.extractions[kind]?.[field]?.confidence;
        return c === undefined ? [] : [{ label: `${kind}.${field}`, confidence: c }];
      }),
    );
  return {
    id: ID,
    category: 'quality',
    weight: config.weights[ID],
    applicableWhen: (ctx) =>
      readings(ctx).length > 0 ? APPLICABLE : skip('No critical field was read from any document'),
    evaluate: (ctx) => {
      const low = readings(ctx).filter(
        (r) => r.confidence < config.thresholds.criticalFieldConfidenceMin,
      );
      return low.length === 0
        ? { passed: true }
        : {
            passed: false,
            penalty: config.weights[ID],
            reason: `${low.length} critical field(s) were read with low confidence (below ${config.thresholds.criticalFieldConfidenceMin})`,
            details: {
              fields: low.map((r) => r.label),
              lowestConfidence: round4(Math.min(...low.map((r) => r.confidence))),
            },
          };
    },
  };
};
