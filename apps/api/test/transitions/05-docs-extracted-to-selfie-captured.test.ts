import { describe, expect, it } from 'vitest';
import {
  docsExtracted,
  docsUploaded,
  expectLastTransition,
  newWorld,
  statusOf,
} from './support.js';

describe('DOCS_EXTRACTED -> SELFIE_CAPTURED', () => {
  it('happens when the customer uploads a selfie, and the risk job is queued once both checks are done', async () => {
    const h = await newWorld();
    const { customer, sessionId } = await docsExtracted(h);

    await h.completeSelfie(customer, sessionId);
    const t = expectLastTransition(h, sessionId, 'DOCS_EXTRACTED', 'SELFIE_CAPTURED');
    // Credited to the customer who took the selfie.
    expect(t).toMatchObject({
      actorType: 'USER',
      actorId: h.store.users.find((u) => u.email === 'a@kycsetu.dev')?.id,
    });
    expect(h.enqueuer.riskQueued).toEqual([{ sessionId, run: 1 }]);
  });

  it('is refused before the documents have been read', async () => {
    const h = await newWorld();
    const { customer, sessionId } = await docsUploaded(h);
    await expect(h.completeSelfie(customer, sessionId)).rejects.toThrow(/selfie failed: 409/);
    expect(statusOf(h, sessionId)).toBe('DOCS_UPLOADED');
  });
});
