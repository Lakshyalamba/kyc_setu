import { describe, expect, it } from 'vitest';
import { makeJpeg } from '../fixtures.js';
import { expectLastTransition, newWorld, statusOf, underReview } from './support.js';

describe('RESUBMIT_REQUESTED -> DOCS_UPLOADED', () => {
  it('happens when the customer has replaced every requested document and submits again', async () => {
    const h = await newWorld();
    const { customer, sessionId } = await underReview(h);
    const officer = await h.signedIn('officer@kycsetu.dev', 'officer');
    await officer.post(`/officer/queue/${sessionId}/claim`);
    await officer.post(`/officer/sessions/${sessionId}/decisions`).send({
      decision: 'REQUEST_RESUBMIT',
      reasonCode: 'WRONG_DOCUMENT',
      reasonNote: 'The back of the Aadhaar is cut off',
      resubmitDocumentTypes: ['AADHAAR_BACK'],
    });
    expect(statusOf(h, sessionId)).toBe('RESUBMIT_REQUESTED');

    // Submitting before the slot is refilled is refused.
    expect((await h.submit(customer, sessionId)).status).toBe(409);

    const up = await customer
      .post(`/kyc/sessions/${sessionId}/documents`)
      .field('type', 'AADHAAR_BACK')
      .attach('file', makeJpeg(4000, 9), { filename: 'x', contentType: 'image/jpeg' });
    expect(up.status).toBe(201);
    const res = await h.submit(customer, sessionId);
    expect(res.status).toBe(200);
    const t = expectLastTransition(h, sessionId, 'RESUBMIT_REQUESTED', 'DOCS_UPLOADED');
    expect(t.actorType).toBe('USER');
    // Only the replaced document is read again.
    expect(h.enqueuer.queued.slice(-1)).toEqual([up.body.documentId]);
  });
});
