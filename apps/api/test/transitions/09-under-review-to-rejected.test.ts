import { describe, expect, it } from 'vitest';
import { expectLastTransition, newWorld, underReview } from './support.js';

describe('UNDER_REVIEW -> REJECTED', () => {
  it('needs a reason code and a note, and ends the application for good', async () => {
    const h = await newWorld();
    const { customer, sessionId } = await underReview(h);
    const officer = await h.signedIn('officer@kycsetu.dev', 'officer');
    await officer.post(`/officer/queue/${sessionId}/claim`);

    const bare = await officer
      .post(`/officer/sessions/${sessionId}/decisions`)
      .send({ decision: 'REJECT' });
    expect(bare.status).toBe(400);

    const res = await officer.post(`/officer/sessions/${sessionId}/decisions`).send({
      decision: 'REJECT',
      reasonCode: 'FACE_MISMATCH',
      reasonNote: 'The selfie is a different person from the ID photo.',
    });
    expect(res.status).toBe(201);
    expect(expectLastTransition(h, sessionId, 'UNDER_REVIEW', 'REJECTED').actorId).toBe(
      h.officers.one.id,
    );
    const status = await customer.get('/kyc/status');
    expect(status.status).toBe(200);
    // A rejected application cannot be decided again.
    const again = await officer
      .post(`/officer/sessions/${sessionId}/decisions`)
      .send({ decision: 'APPROVE' });
    expect(again.status).toBeGreaterThanOrEqual(400);
  });
});
