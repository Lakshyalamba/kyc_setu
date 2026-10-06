import { describe, expect, it } from 'vitest';
import { defaultConfig, type RiskConfig } from '../src/config.js';
import { bandFor, runRiskEngine } from '../src/engine.js';
import { createRules } from '../src/rules/index.js';
import type { Rule, RuleInput } from '../src/types.js';
import { ENGINE_VERSION } from '../src/version.js';
import { build, happyContext } from './builders.js';

/** A rule that always fires with the given penalty (to test the engine, not the rules). */
const fixed = (id: string, penalty: number, weight = penalty, extra: Partial<Rule> = {}): Rule => ({
  id,
  category: 'identity',
  weight,
  applicableWhen: () => ({ applicable: true }),
  evaluate: () => ({ passed: false, penalty, reason: `${id} fired` }),
  ...extra,
});
const clean = (id: string): Rule => ({
  id,
  category: 'quality',
  weight: 5,
  applicableWhen: () => ({ applicable: true }),
  evaluate: () => ({ passed: true }),
});

describe('band table', () => {
  it('covers 0-100 with no gaps or overlaps', () => {
    const { LOW, MEDIUM, HIGH } = defaultConfig.bands;
    expect(LOW[0]).toBe(0);
    expect(MEDIUM[0]).toBe(LOW[1] + 1);
    expect(HIGH[0]).toBe(MEDIUM[1] + 1);
    expect(HIGH[1]).toBe(100);
  });

  it.each([
    [0, 'LOW'],
    [14, 'LOW'],
    [15, 'MEDIUM'],
    [55, 'MEDIUM'],
    [56, 'HIGH'],
    [100, 'HIGH'],
  ] as const)('score %i is %s', (score, band) =>
    expect(bandFor(score, defaultConfig.bands)).toBe(band),
  ); // fmt: skip
});

describe('runRiskEngine', () => {
  it('sums penalties, clamps to 100, and maps to a band', () => {
    const r = runRiskEngine(happyContext(), [fixed('a', 60), fixed('b', 70)]);
    expect(r.score).toBe(100);
    expect(r.rawBand).toBe('HIGH');
    expect(r.triggeredRules.map((t) => t.penalty)).toEqual([60, 70]); // the per-rule penalties are not clamped
  });

  it('never lets a rule add more than its weight (and never a negative penalty)', () => {
    const r = runRiskEngine(happyContext(), [fixed('greedy', 90, 10), fixed('negative', -5, 10)]);
    expect(r.triggeredRules.find((t) => t.ruleId === 'greedy')?.penalty).toBe(10);
    expect(r.triggeredRules.find((t) => t.ruleId === 'negative')?.penalty).toBe(0);
    expect(r.score).toBe(10);
  });

  it('evaluates in rule-id order, whatever order the rules are given in', () => {
    const rules = [fixed('c', 1), fixed('a', 1), clean('b'), fixed('d', 1)];
    const forward = runRiskEngine(happyContext(), rules);
    const backward = runRiskEngine(happyContext(), [...rules].reverse());
    expect(forward.appliedRules).toEqual(['a', 'b', 'c', 'd']);
    expect(forward.triggeredRules.map((t) => t.ruleId)).toEqual(['a', 'c', 'd']);
    expect(JSON.stringify(backward)).toBe(JSON.stringify(forward));
  });

  it('is order-independent for the real rule set too', () => {
    const ctx = build((c) => {
      c.faceMatch = { score: 0.5 };
      c.comparisons.panTypedMatchesExtracted = false;
      c.liveness = { passed: false };
    });
    const rules = createRules();
    const shuffled = [...rules].sort(
      (a, b) => ((a.id.length * 7) % 5) - ((b.id.length * 7) % 5) || (a.id < b.id ? 1 : -1),
    );
    expect(JSON.stringify(runRiskEngine(ctx, shuffled))).toBe(
      JSON.stringify(runRiskEngine(ctx, rules)),
    );
  });

  it('records skipped rules with their reason, and does not count them as passed', () => {
    const ctx = build((c) => {
      c.faceMatch = null;
      c.liveness = null;
    });
    const r = runRiskEngine(ctx, createRules());
    expect(r.skippedRules.map((s) => s.ruleId)).toEqual([
      'face-match-below-threshold',
      'face-match-borderline',
      'liveness-failed',
    ]);
    expect(r.skippedRules.every((s) => s.reason.length > 0)).toBe(true);
    expect(r.appliedRules).not.toContain('liveness-failed');
  });

  it('turns a throwing rule into a data-integrity penalty instead of an exception', () => {
    const boom = clean('boom');
    boom.evaluate = () => {
      throw new Error('kaboom');
    };
    const brokenApplicability = clean('broken');
    brokenApplicability.applicableWhen = () => {
      throw new Error('nope');
    };
    const r = runRiskEngine(happyContext(), [boom, brokenApplicability, fixed('fine', 10)]);
    expect(r.triggeredRules.map((t) => t.ruleId)).toEqual(['fine', 'rule-evaluation-error']);
    const meta = r.triggeredRules.find((t) => t.ruleId === 'rule-evaluation-error');
    expect(meta).toMatchObject({
      category: 'data_integrity',
      penalty: 20,
      details: { failedRules: ['boom', 'broken'] },
    });
    expect(JSON.stringify(r)).not.toMatch(/kaboom|nope/); // error messages never leak into the report
    expect(r.score).toBe(30);
  });

  it('applies band floors: the score stays honest, the band is raised, and the report says why', () => {
    const r = runRiskEngine(
      build((c) => {
        c.faceMatch = { score: 0.2 };
      }),
      createRules(),
    );
    expect(r).toMatchObject({ score: 35, rawBand: 'MEDIUM', band: 'HIGH', hardFail: false });
    expect(r.bandFloors).toEqual([{ ruleId: 'face-match-below-threshold', band: 'HIGH' }]);
  });

  it('hard-fail forces HIGH whatever the score, and a floor never lowers a band', () => {
    const underage = runRiskEngine(
      build((c) => {
        c.personal.dateOfBirth = '2012-01-01';
      }),
      createRules(),
    );
    expect(underage).toMatchObject({ hardFail: true, band: 'HIGH' });
    const cfg: RiskConfig = { ...defaultConfig, bandFloors: { 'face-match-borderline': 'LOW' } };
    const r = runRiskEngine(
      build((c) => {
        c.faceMatch = { score: 0.7 };
      }),
      createRules(cfg),
      { config: cfg },
    );
    expect(r.band).toBe('MEDIUM');
  });

  it('weights and bands come from the config, not from the rules', () => {
    const cfg: RiskConfig = {
      ...defaultConfig,
      weights: { ...defaultConfig.weights, 'liveness-failed': 5 },
      bands: { LOW: [0, 4], MEDIUM: [5, 9], HIGH: [10, 100] },
    };
    const ctx = build((c) => {
      c.liveness = { passed: false };
    });
    const r = runRiskEngine(ctx, createRules(cfg), { config: cfg });
    expect(r).toMatchObject({ score: 5, band: 'MEDIUM' });
  });

  it('reports a clean run as LOW with nothing triggered', () => {
    const r = runRiskEngine(happyContext(), createRules());
    expect(r).toMatchObject({
      score: 0,
      band: 'LOW',
      rawBand: 'LOW',
      hardFail: false,
      triggeredRules: [],
      bandFloors: [],
      skippedRules: [],
    });
    expect(r.appliedRules).toHaveLength(17);
    expect(r.engineVersion).toBe(ENGINE_VERSION);
  });

  it('defaults `now` when it is not supplied, and lets a caller inject it', () => {
    const withoutNow: RuleInput = structuredClone(happyContext());
    delete withoutNow.now;
    expect(runRiskEngine(withoutNow, createRules()).band).toBe('LOW');
    const young = {
      ...withoutNow,
      personal: { ...withoutNow.personal, dateOfBirth: '2008-06-01' },
    };
    expect(
      runRiskEngine({ ...young, now: new Date('2026-05-31T00:00:00Z') }, createRules()).hardFail,
    ).toBe(true); // 17
    expect(
      runRiskEngine({ ...young, now: new Date('2026-06-01T00:00:00Z') }, createRules()).hardFail,
    ).toBe(false); // 18
  });
});

describe('the default rule set', () => {
  const rules = createRules();
  it('has 17 uniquely named kebab-case rules whose weights come from the config', () => {
    expect(rules).toHaveLength(17);
    expect(new Set(rules.map((r) => r.id)).size).toBe(17);
    for (const r of rules) {
      expect(r.id).toMatch(/^[a-z]+(-[a-z0-9]+)+$/);
      expect(r.weight).toBe((defaultConfig.weights as Record<string, number>)[r.id]);
    }
  });
  it('has a weight for every rule id and the meta-rule', () => {
    expect(Object.keys(defaultConfig.weights).sort()).toEqual(
      [...rules.map((r) => r.id), 'rule-evaluation-error'].sort(),
    );
  });
});
