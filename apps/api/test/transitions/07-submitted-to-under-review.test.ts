import { describe, expect, it } from 'vitest';
import { expectLastTransition, newWorld, selfieCaptured, transitionsOf } from './support.js';

describe('SUBMITTED -> UNDER_REVIEW', () => {
  it("puts the application in the officers' queue, with its risk band", async () => {
    const h = await newWorld();
    const { sessionId } = await selfieCaptured(h);
    await h.runQueuedRisk();
    const t = expectLastTransition(h, sessionId, 'SUBMITTED', 'UNDER_REVIEW');
    expect(t.actorType).toBe('SYSTEM');
    const officer = await h.signedIn('officer@kycsetu.dev', 'officer');
    const queue = await officer.get('/officer/queue');
    expect(queue.body.items.map((i: { sessionId: string }) => i.sessionId)).toContain(sessionId);
  });

  it('finishes the job if the worker stopped between the two steps, without assessing twice', async () => {
    const h = await newWorld();
    const { sessionId } = await selfieCaptured(h);
    await h.runQueuedRisk();
    // Put the session back where a crash between SELFIE_CAPTURED -> SUBMITTED and SUBMITTED -> UNDER_REVIEW leaves it.
    const session = h.kycStore.sessions.find((s) => s.id === sessionId)!;
    session.status = 'SUBMITTED';
    const before = transitionsOf(h, sessionId).length;

    const out = await h.services.risk.runAutomatic(sessionId);
    expect(out).toMatchObject({ kind: 'assessed', finalStatus: 'UNDER_REVIEW' });
    expect(transitionsOf(h, sessionId)).toHaveLength(before + 1);
    expectLastTransition(h, sessionId, 'SUBMITTED', 'UNDER_REVIEW');
    expect(h.riskStore.assessments.filter((a) => a.sessionId === sessionId)).toHaveLength(1);
  });
});
