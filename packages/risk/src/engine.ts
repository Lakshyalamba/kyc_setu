import { META_RULE_EVALUATION_ERROR, defaultConfig, type RiskConfig } from './config.js';
import type { Band, Rule, RuleContext, RuleInput, RiskResult, TriggeredRule } from './types.js';
import { ENGINE_VERSION } from './version.js';

const BAND_ORDER: readonly Band[] = ['LOW', 'MEDIUM', 'HIGH'];
const higherBand = (a: Band, b: Band): Band =>
  BAND_ORDER.indexOf(a) >= BAND_ORDER.indexOf(b) ? a : b;

/** Maps a 0-100 score to its band using the (inclusive) ranges in the config. */
export function bandFor(score: number, bands: RiskConfig['bands']): Band {
  for (const band of BAND_ORDER) {
    const [low, high] = bands[band];
    if (score >= low && score <= high) return band;
  }
  return 'HIGH'; // unreachable for a valid config (see engine.test.ts), kept total on purpose
}

const byId = (a: Rule, b: Rule): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * Pure: (context, rules) -> result. No I/O, no clock (the only time is `now`, injected), no randomness.
 *
 *  - Rules run sorted by id, so the report for the same inputs is always in the same order.
 *  - A rule that is not applicable is *skipped* (with a reason), never silently passed.
 *  - A rule that throws never crashes the run: it is recorded and surfaces as the `rule-evaluation-error`
 *    meta-rule, a data-integrity penalty.
 *  - Penalties are summed and clamped to 0-100. The band comes from the score, then band floors and
 *    hard-fail rules can only raise it.
 */
export function runRiskEngine(
  input: RuleInput,
  rules: readonly Rule[],
  opts: { config?: RiskConfig } = {},
): RiskResult {
  const config = opts.config ?? defaultConfig;
  const ctx: RuleContext = { ...input, now: input.now ?? new Date() };

  const triggeredRules: TriggeredRule[] = [];
  const appliedRules: string[] = [];
  const skippedRules: RiskResult['skippedRules'] = [];
  const failedToEvaluate: string[] = [];

  for (const rule of [...rules].sort(byId)) {
    try {
      const applicability = rule.applicableWhen(ctx);
      if (!applicability.applicable) {
        skippedRules.push({ ruleId: rule.id, reason: applicability.reason });
        continue;
      }
      appliedRules.push(rule.id);
      const outcome = rule.evaluate(ctx);
      if (!outcome.passed) {
        // `weight` is the most a rule may add, whatever it returns.
        const penalty = Math.min(Math.max(Math.round(outcome.penalty), 0), rule.weight);
        triggeredRules.push({
          ruleId: rule.id,
          category: rule.category,
          penalty,
          reason: outcome.reason,
          ...(outcome.details ? { details: outcome.details } : {}),
        });
      }
    } catch {
      if (!appliedRules.includes(rule.id)) appliedRules.push(rule.id);
      failedToEvaluate.push(rule.id);
    }
  }

  if (failedToEvaluate.length > 0) {
    appliedRules.push(META_RULE_EVALUATION_ERROR);
    triggeredRules.push({
      ruleId: META_RULE_EVALUATION_ERROR,
      category: 'data_integrity',
      penalty: config.weights[META_RULE_EVALUATION_ERROR],
      reason: `${failedToEvaluate.length} rule(s) could not be evaluated`,
      details: { failedRules: failedToEvaluate },
    });
  }

  const score = Math.min(
    100,
    triggeredRules.reduce((sum, t) => sum + t.penalty, 0),
  );
  const rawBand = bandFor(score, config.bands);

  const bandFloors: RiskResult['bandFloors'] = [];
  let band = rawBand;
  for (const t of triggeredRules) {
    const floor = (config.bandFloors as Record<string, Band | undefined>)[t.ruleId];
    if (floor) {
      bandFloors.push({ ruleId: t.ruleId, band: floor });
      band = higherBand(band, floor);
    }
  }
  const hardFail = triggeredRules.some((t) =>
    (config.hardFailRules as readonly string[]).includes(t.ruleId),
  );
  if (hardFail) band = 'HIGH';

  return {
    score,
    band,
    rawBand,
    hardFail,
    triggeredRules,
    bandFloors,
    appliedRules,
    skippedRules,
    engineVersion: ENGINE_VERSION,
  };
}
