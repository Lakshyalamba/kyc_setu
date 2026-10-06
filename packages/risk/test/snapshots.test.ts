import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runRiskEngine } from '../src/engine.js';
import { createRules } from '../src/rules/index.js';
import type { RiskResult, RuleContext } from '../src/types.js';

const DIR = path.resolve(import.meta.dirname, 'snapshots');
const load = (name: string): RuleContext => {
  const raw = JSON.parse(readFileSync(path.join(DIR, `${name}.json`), 'utf8')) as Omit<
    RuleContext,
    'now'
  > & { now: string };
  return { ...raw, now: new Date(raw.now) };
};
const names = readdirSync(DIR)
  .filter((f) => f.endsWith('.json'))
  .map((f) => f.replace(/\.json$/, ''))
  .sort();

/** What each scenario must mean, independent of the exact numbers in the committed snapshot. */
const EXPECT: Record<string, (r: RiskResult) => void> = {
  'happy-path': (r) => {
    expect(r.band).toBe('LOW');
    expect(r.triggeredRules).toEqual([]);
    expect(r.score).toBe(0);
  },
  'stranger-selfie': (r) => {
    expect(r.band).toBe('HIGH');
    expect(r.rawBand).toBe('MEDIUM'); // the floor, not the score, makes it HIGH
    expect(r.triggeredRules[0]?.ruleId).toBe('face-match-below-threshold');
    expect(r.triggeredRules).toHaveLength(1);
  },
  'typo-name': (r) => {
    expect(r.band).toBe('MEDIUM');
    expect(r.triggeredRules.map((t) => t.ruleId)).toEqual(['name-mismatch-form-pan']);
  },
  'dob-off-by-one': (r) => {
    expect(r.band).toBe('MEDIUM');
    expect(r.triggeredRules.map((t) => t.ruleId)).toEqual([
      'dob-mismatch-form-docs',
      'dob-mismatch-pan-aadhaar',
    ]);
  },
  underage: (r) => {
    expect(r.band).toBe('HIGH');
    expect(r.hardFail).toBe(true);
    expect(r.triggeredRules.map((t) => t.ruleId)).toEqual(['age-ineligible']);
  },
  'duplicate-pan': (r) => {
    expect(r.band).toBe('HIGH');
    expect(r.triggeredRules.map((t) => t.ruleId)).toEqual(['duplicate-pan-approved']);
  },
  'pan-tampered': (r) => {
    expect(r.band).toBe('MEDIUM');
    expect(r.triggeredRules.map((t) => t.ruleId)).toEqual(['pan-form-mismatch']);
  },
  'borderline-face': (r) => {
    expect(r.band).toBe('MEDIUM');
    expect(r.triggeredRules.map((t) => t.ruleId)).toEqual(['face-match-borderline']);
  },
  'wrong-document': (r) => {
    expect(r.band).toBe('MEDIUM'); // not LOW: skipped rules must not look like a clean bill of health
    expect(r.triggeredRules.map((t) => t.ruleId)).toEqual(['extraction-unusable']);
    expect(r.skippedRules.length).toBeGreaterThan(0);
  },
  'everything-wrong': (r) => {
    expect(r.score).toBe(100);
    expect(r.band).toBe('HIGH');
  },
};

describe('engine snapshots', () => {
  it('has a fixture for every scenario we make claims about', () => {
    expect(names).toEqual(Object.keys(EXPECT).sort());
  });

  it.each(names)('%s', async (name) => {
    const result = runRiskEngine(load(name), createRules());
    EXPECT[name]?.(result);
    // The whole result is committed, so any rule or weight change shows up as a reviewable diff.
    await expect(JSON.stringify(result, null, 2) + '\n').toMatchFileSnapshot(
      `./snapshots/expected/${name}.result.json`,
    );
  });
});
