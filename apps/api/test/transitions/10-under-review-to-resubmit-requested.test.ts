import { describe, expect, it } from 'vitest';
import { expectLastTransition, newWorld, underReview } from './support.js';

describe('UNDER_REVIEW -> RESUBMIT_REQUESTED', () => {
  it('opens only the slots the officer names, and tells the customer which', async () => {
    const h = await newWorld();
    const { sessionId } = await underReview(h);
    const officer = await h.signedIn('officer@kycsetu.dev', 'officer');
    await officer.post(`/officer/queue/${sessionId}/claim`);

    const res = await officer.post(`/officer/sessions/${sessionId}/decisions`).send({
      decision: 'REQUEST_RESUBMIT',
      reasonCode: 'WRONG_DOCUMENT',
      reasonNote: 'The back of the Aadhaar is cut off',
      resubmitDocumentTypes: ['AADHAAR_BACK'],
    });
    expect(res.status).toBe(201);
    expectLastTransition(h, sessionId, 'UNDER_REVIEW', 'RESUBMIT_REQUESTED');
    const session = h.kycStore.sessions.find((s) => s.id === sessionId)!;
    expect(session).toMatchObject({ currentStep: 'DOCUMENTS', resubmitTypes: ['AADHAAR_BACK'] });
  });

  it('needs at least one slot to open', async () => {
    const h = await newWorld();
    const { sessionId } = await underReview(h);
    const officer = await h.signedIn('officer@kycsetu.dev', 'officer');
    await officer.post(`/officer/queue/${sessionId}/claim`);
    const res = await officer.post(`/officer/sessions/${sessionId}/decisions`).send({
      decision: 'REQUEST_RESUBMIT',
      reasonCode: 'WRONG_DOCUMENT',
      reasonNote: 'x',
      resubmitDocumentTypes: [],
    });
    expect(res.status).toBe(400);
  });
});
