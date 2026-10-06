import type { Applicability, DocKind, ExtractionFacts, RuleContext } from '../types.js';

export const APPLICABLE: Applicability = { applicable: true };
export const skip = (reason: string): Applicability => ({ applicable: false, reason });
export const round4 = (n: number): number => Math.round(n * 10_000) / 10_000;

export const extraction = (ctx: RuleContext, kind: DocKind): ExtractionFacts | undefined =>
  ctx.extractions[kind];
