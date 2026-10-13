import { describe, expect, it } from 'vitest';
import {
  docsExtracted,
  docsUploaded,
  expectLastTransition,
  newWorld,
  statusOf,
} from './support.js';

const signals = {
  faceMatch: { score: 0.92, modelVersion: 'test-1' },
  liveness: { passed: true },
};

// The selfie step is not built (Phase 4), so this edge is fired by the development signal injector, which records the
// same face-match and liveness signals the selfie step will.
describe('DOCS_EXTRACTED -> SELFIE_CAPTURED', () => {
  it('happens when face-match and liveness signals are recorded, and queues the automatic risk assessment', async () => {
    const h = await newWorld();
    const { sessionId } = await docsExtracted(h);
    const officer = await h.signedIn('officer@kycsetu.dev', 'officer');

    const res = await officer.post(`/dev/sessions/${sessionId}/biometrics`).send(signals);
    expect(res.status).toBe(200);
    const t = expectLastTransition(h, sessionId, 'DOCS_EXTRACTED', 'SELFIE_CAPTURED');
    // Credited to the officer who used the injector, since there is no customer action to credit.
    expect(t).toMatchObject({ actorType: 'USER', actorId: h.officers.one.id });
    expect(h.enqueuer.riskQueued).toEqual([{ sessionId, run: 1 }]);
  });

  it('is refused before the documents have been read', async () => {
    const h = await newWorld();
    const { sessionId } = await docsUploaded(h);
    const officer = await h.signedIn('officer@kycsetu.dev', 'officer');
    const res = await officer.post(`/dev/sessions/${sessionId}/biometrics`).send(signals);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(statusOf(h, sessionId)).toBe('DOCS_UPLOADED');
  });
});
