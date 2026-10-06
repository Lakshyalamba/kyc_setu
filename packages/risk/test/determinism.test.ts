import { describe, expect, it } from 'vitest';
import { runRiskEngine } from '../src/engine.js';
import { summarizeInputs } from '../src/features.js';
import { createRules } from '../src/rules/index.js';
import { build, happyContext } from './builders.js';

const noisy = () =>
  build((c) => {
    c.faceMatch = { score: 0.7 };
    c.liveness = { passed: false };
    c.comparisons.panTypedMatchesExtracted = false;
    c.personal.fullName = 'Raul Kumr Sarma';
    c.priorApprovedMatches = [
      {
        userId: 'user-9',
        sessionId: 'session-b',
        panMatch: true,
        aadhaarLast4Match: true,
        aadhaarFullMatch: true,
      },
      {
        userId: 'user-8',
        sessionId: 'session-a',
        panMatch: true,
        aadhaarLast4Match: false,
        aadhaarFullMatch: false,
      },
    ];
  });

describe('determinism', () => {
  it('the same context twice gives byte-identical JSON', () => {
    const a = JSON.stringify(runRiskEngine(noisy(), createRules()));
    const b = JSON.stringify(runRiskEngine(noisy(), createRules()));
    expect(a).toBe(b);
  });

  it('does not depend on the wall clock when `now` is supplied', () => {
    const first = JSON.stringify(runRiskEngine(happyContext(), createRules()));
    const second = JSON.stringify(
      runRiskEngine({ ...happyContext(), now: new Date('2026-10-10T00:00:00Z') }, createRules()),
    );
    expect(second).toBe(first);
  });

  it('does not mutate its input', () => {
    const ctx = noisy();
    const before = JSON.stringify(ctx);
    runRiskEngine(ctx, createRules());
    expect(JSON.stringify(ctx)).toBe(before);
  });

  it('the stored input summary is deterministic and contains no names, dates of birth or document numbers', () => {
    const ctx = noisy();
    const a = JSON.stringify(summarizeInputs(ctx));
    expect(JSON.stringify(summarizeInputs(noisy()))).toBe(a);
    for (const pii of ['Raul', 'RAHUL', 'SHARMA', '1990-05-15', 'Kumr'])
      expect(a).not.toContain(pii);
    expect(JSON.parse(a)).toMatchObject({
      nameSimilarity: { formVsPan: 0.8333 },
      faceMatch: { score: 0.7 },
      priorApproved: { count: 2, panMatches: 2, aadhaarFullMatches: 1 },
    });
  });

  it('rule explanations and details carry no names or dates either', () => {
    const r = runRiskEngine(noisy(), createRules());
    expect(JSON.stringify(r)).not.toMatch(/Raul|RAHUL|SHARMA|1990-05-15/);
  });
});
