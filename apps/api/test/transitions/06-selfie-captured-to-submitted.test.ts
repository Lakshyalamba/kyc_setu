import { describe, expect, it } from 'vitest';
import { newWorld, selfieCaptured, statusOf, transitionsOf } from './support.js';

describe('SELFIE_CAPTURED -> SUBMITTED', () => {
  it('is fired by the risk job after it records an assessment, and is persisted on its own (so the audit log shows both steps)', async () => {
    const h = await newWorld();
    const { sessionId } = await selfieCaptured(h);
    expect(statusOf(h, sessionId)).toBe('SELFIE_CAPTURED');

    const [outcome] = await h.runQueuedRisk();
    expect(outcome).toMatchObject({ kind: 'assessed' });
    const steps = transitionsOf(h, sessionId).map((t) => `${t.from}>${t.to}`);
    expect(steps.slice(-2)).toEqual(['SELFIE_CAPTURED>SUBMITTED', 'SUBMITTED>UNDER_REVIEW']);
    expect(h.riskStore.assessments.filter((a) => a.sessionId === sessionId)).toHaveLength(1);
  });

  it('does not run for a session that is not at SELFIE_CAPTURED', async () => {
    const h = await newWorld();
    const { sessionId } = await selfieCaptured(h);
    await h.runQueuedRisk();
    const again = await h.services.risk.runAutomatic(sessionId);
    expect(again).toMatchObject({ kind: 'skipped' });
    expect(h.riskStore.assessments.filter((a) => a.sessionId === sessionId)).toHaveLength(1);
  });
});
