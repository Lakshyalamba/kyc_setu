import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { extractResponseSchema } from '@kyc-setu/shared';
import { createHarness } from './harness.js';
import { testEnv } from './helpers.js';

const ID = '3f2b8c1e-5a4d-4e6f-9b7a-1c2d3e4f5a6b';
const body = { documentId: ID, sessionId: ID, signedUrl: 'http://x/files/t' };
const key = testEnv().AI_INTERNAL_KEY;

describe('the AI service stand-in (/dev/ai-mock)', () => {
  it('answers like the real service, for the document it was asked about', async () => {
    const h = await createHarness();
    const pan = await request(h.app)
      .post('/dev/ai-mock/extract/pan')
      .set('x-internal-key', key)
      .send(body);
    expect(pan.status).toBe(200);
    expect(extractResponseSchema.parse(pan.body)).toMatchObject({ documentId: ID });
    const back = await request(h.app)
      .post('/dev/ai-mock/extract/aadhaar')
      .set('x-internal-key', key)
      .send({ ...body, documentType: 'AADHAAR_BACK' });
    expect(extractResponseSchema.parse(back.body).fields).toHaveProperty('address');
  });

  it('refuses a caller without the internal key, as the real service does', async () => {
    const h = await createHarness();
    expect((await request(h.app).post('/dev/ai-mock/extract/pan').send(body)).status).toBe(401);
    expect(
      (
        await request(h.app)
          .post('/dev/ai-mock/extract/pan')
          .set('x-internal-key', 'wrong')
          .send(body)
      ).status,
    ).toBe(401);
  });

  it('is ready, so /readyz of an API pointed at it is too', async () => {
    const h = await createHarness();
    expect((await request(h.app).get('/dev/ai-mock/readyz')).body).toMatchObject({ status: 'ok' });
  });
});
