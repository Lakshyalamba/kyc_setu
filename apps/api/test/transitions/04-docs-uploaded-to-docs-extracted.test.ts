import { describe, expect, it } from 'vitest';
import {
  docsUploaded,
  expectLastTransition,
  newWorld,
  statusOf,
  transitionsOf,
} from './support.js';

describe('DOCS_UPLOADED -> DOCS_EXTRACTED', () => {
  it('is fired by the worker when the last of the three documents has a finished extraction, and by nobody before', async () => {
    const h = await newWorld();
    const { sessionId, ids } = await docsUploaded(h);

    await h.process(ids.PAN);
    await h.process(ids.AADHAAR_FRONT);
    expect(statusOf(h, sessionId)).toBe('DOCS_UPLOADED'); // two of three: still waiting

    await h.process(ids.AADHAAR_BACK);
    const t = expectLastTransition(h, sessionId, 'DOCS_UPLOADED', 'DOCS_EXTRACTED');
    expect(t.actorType).toBe('SYSTEM');
    expect(t.actorId).toBeNull();
  });

  it('does not happen twice if a job is run again', async () => {
    const h = await newWorld();
    const { sessionId, ids } = await docsUploaded(h);
    for (const t of ['PAN', 'AADHAAR_FRONT', 'AADHAAR_BACK'] as const) await h.process(ids[t]);
    await h.process(ids.PAN); // a duplicate delivery
    expect(transitionsOf(h, sessionId).filter((t) => t.to === 'DOCS_EXTRACTED')).toHaveLength(1);
  });
});
