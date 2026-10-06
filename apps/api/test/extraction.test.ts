import { UnrecoverableError, type Job } from 'bullmq';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { decryptPii } from '@kyc-setu/shared/pii';
import { parsePiiKey } from '@kyc-setu/shared/pii';
import { decryptToBuffer } from '@kyc-setu/shared/crypto';
import { Readable } from 'node:stream';
import { signToken } from '../src/lib/jwt.js';
import { AiServiceError } from '../src/modules/extraction/ai-client.js';
import { panBlindIndex, redactAadhaar } from '../src/modules/extraction/pii.js';
import { sweepExpiredRawText } from '../src/modules/extraction/retention.js';
import { requeueStalePending, type ExtractJobData } from '../src/queue/verification.js';
import { backoffDelayMs, createVerificationProcessor } from '../src/workers/verification.js';
import { aiResponse, testEnv, unreachableAi } from './helpers.js';
import { createHarness, type Agent, type Harness } from './harness.js';

let h: Harness;
let a: Agent;
beforeEach(async () => {
  h = await createHarness();
  a = await h.signedIn('a@kycsetu.dev');
});

async function submitted() {
  const docs = await h.withDocuments(a);
  const res = await h.submit(a, docs.sessionId);
  expect(res.status).toBe(200);
  return docs;
}

describe('documents submit -> extraction work', () => {
  it('creates one extraction per document in the same step: 3 pending + a skipped signature', async () => {
    const { sessionId, ids } = await submitted();
    expect(h.kycStore.sessions[0]?.status).toBe('DOCS_UPLOADED');
    const statuses = Object.fromEntries(
      [...h.extractionStore.rows.values()].map((r) => [r.documentId, r.status]),
    );
    expect(statuses).toEqual({
      [ids.PAN]: 'PENDING',
      [ids.AADHAAR_FRONT]: 'PENDING',
      [ids.AADHAAR_BACK]: 'PENDING',
      [ids.SIGNATURE]: 'SKIPPED',
    });
    expect(h.enqueuer.queued.sort()).toEqual([ids.PAN, ids.AADHAAR_FRONT, ids.AADHAAR_BACK].sort());
    const enq = h.audits.filter((x) => x.action === 'extraction.job_enqueued');
    expect(enq).toHaveLength(3);
    expect(enq.every((x) => x.metadata?.['sessionId'] === sessionId)).toBe(true);
  });

  it('does not fail the submit if the queue is down; the rows stay PENDING and recovery re-queues them', async () => {
    h.enqueuer.failNext = true;
    const { ids } = await submitted();
    expect(h.kycStore.sessions[0]?.status).toBe('DOCS_UPLOADED');
    expect(h.enqueuer.queued).toEqual([]);
    const requeued = await requeueStalePending(h.extractionStore, h.enqueuer, 1_000);
    expect(requeued).toBe(3);
    expect(h.enqueuer.queued.sort()).toEqual([ids.PAN, ids.AADHAAR_FRONT, ids.AADHAAR_BACK].sort());
  });

  it('recovery ignores rows that are brand new or already finished', async () => {
    const { ids } = await submitted();
    await h.process(ids.PAN);
    h.enqueuer.queued.length = 0;
    expect(await requeueStalePending(h.extractionStore, h.enqueuer, 10 * 60_000)).toBe(0); // all too young
    expect(await requeueStalePending(h.extractionStore, h.enqueuer, 1_000)).toBe(2); // PAN is done
  });
});

describe('processing', () => {
  it('stores results, encrypts the PAN and the raw text, and moves the session to DOCS_EXTRACTED', async () => {
    const { ids } = await submitted();
    for (const type of ['PAN', 'AADHAAR_FRONT', 'AADHAAR_BACK'] as const) {
      expect(await h.process(ids[type])).toEqual({ kind: 'done', status: 'OK' });
    }
    expect(h.kycStore.sessions[0]).toMatchObject({ status: 'DOCS_EXTRACTED', flags: [] });

    const pan = h.extractionStore.rows.get(ids.PAN);
    const fields = pan?.fields as Record<string, { value: string }>;
    expect(fields['name']?.value).toBe('RAHUL KUMAR SHARMA'); // non-sensitive values stay readable
    expect(fields['panNumber']?.value).toMatch(/^enc:v1:/);
    expect(
      decryptPii(fields['panNumber']?.value ?? '', parsePiiKey(testEnv().PII_ENCRYPTION_KEY)),
    ).toBe('ABCDE1234F');
    expect(JSON.stringify(pan)).not.toContain('ABCDE1234F');
    expect(pan?.panNumberHmac).toBe(
      panBlindIndex('ABCDE1234F', parsePiiKey(testEnv().PII_ENCRYPTION_KEY)),
    );

    const front = h.extractionStore.rows.get(ids.AADHAAR_FRONT);
    expect(front?.aadhaarNumberLast4).toBe('4321');
    expect((front?.fields as Record<string, { value: string }>)['aadhaarNumber']?.value).toBe(
      'XXXX-XXXX-4321',
    );

    // Raw text is envelope encrypted and decrypts back to what the AI service sent.
    expect(pan?.rawTextEncrypted?.includes(Buffer.from('ABCDE1234F'))).toBe(false);
    const plain = await decryptToBuffer(
      Readable.from([pan?.rawTextEncrypted ?? Buffer.alloc(0)]),
      {
        wrappedKey: pan?.encryptedDataKey as Buffer,
        iv: pan?.iv as Buffer,
        authTag: pan?.authTag as Buffer,
        kmsKeyId: pan?.kmsKeyId ?? '',
      },
      h.services.kms,
    );
    expect(plain.toString()).toContain('INCOME TAX DEPARTMENT');
  });

  it('audits one completed row per document, with field names only', async () => {
    const { ids } = await submitted();
    for (const t of ['PAN', 'AADHAAR_FRONT', 'AADHAAR_BACK'] as const) await h.process(ids[t]);
    const done = h.audits.filter((x) => x.action === 'extraction.completed');
    expect(done).toHaveLength(3);
    expect(done.every((x) => x.actorType === 'AI' && x.actorId === h.service.id)).toBe(true);
    expect(done[0]?.metadata).toMatchObject({
      status: 'OK',
      attempt: 1,
      fieldsFound: ['dob', 'fatherName', 'name', 'panNumber'],
    });
    expect(h.actions()).toContain('kyc.session.transitioned');
    const dump = JSON.stringify(h.audits);
    for (const secret of ['ABCDE1234F', 'RAHUL', '1990-05-15', 'Indiranagar', 'XXXX-XXXX-4321']) {
      expect(dump).not.toContain(secret);
    }
  });

  it('only advances once EVERY document is finished', async () => {
    const { ids } = await submitted();
    await h.process(ids.PAN);
    await h.process(ids.AADHAAR_FRONT);
    expect(h.kycStore.sessions[0]?.status).toBe('DOCS_UPLOADED');
    await h.process(ids.AADHAAR_BACK);
    expect(h.kycStore.sessions[0]?.status).toBe('DOCS_EXTRACTED');
  });

  it.each([
    ['low_quality', 'LOW_QUALITY', 'EXTRACTION_LOW_QUALITY'],
    ['wrong_document', 'WRONG_DOCUMENT', 'EXTRACTION_WRONG_DOCUMENT'],
    ['parse_failed', 'PARSE_FAILED', 'EXTRACTION_PARSE_FAILED'],
  ] as const)(
    'a %s result is stored, still lets the session advance, and flags it for officers',
    async (aiStatus, status, flag) => {
      const { ids } = await submitted();
      h.aiClient.respond = (req) =>
        req.documentId === ids.AADHAAR_FRONT
          ? aiResponse('AADHAAR_FRONT', req.documentId, {
              status: aiStatus,
              fields: {},
              rawText: '',
              quality: {
                ...aiResponse('PAN', req.documentId).quality,
                warnings: ['LOW_SHARPNESS (31.2 < 50)'],
              },
            })
          : aiResponse(req.type, req.documentId);
      for (const t of ['PAN', 'AADHAAR_FRONT', 'AADHAAR_BACK'] as const) await h.process(ids[t]);
      expect(h.extractionStore.rows.get(ids.AADHAAR_FRONT)?.status).toBe(status);
      expect(h.kycStore.sessions[0]).toMatchObject({ status: 'DOCS_EXTRACTED', flags: [flag] });
      expect(
        h.audits.some(
          (x) => x.action === 'extraction.session_flagged' && x.metadata?.['flag'] === flag,
        ),
      ).toBe(true);
    },
  );

  it('is idempotent: a second run (or a stale duplicate job) changes nothing', async () => {
    const { ids } = await submitted();
    await h.process(ids.PAN);
    const calls = h.aiClient.calls.length;
    expect(await h.process(ids.PAN)).toMatchObject({ kind: 'skipped' });
    expect(h.aiClient.calls).toHaveLength(calls);
    expect(h.audits.filter((x) => x.action === 'extraction.completed')).toHaveLength(1);
  });

  it('never extracts a signature', async () => {
    const { ids } = await submitted();
    expect(await h.process(ids.SIGNATURE)).toMatchObject({ kind: 'skipped' });
    expect(h.aiClient.calls).toHaveLength(0);
  });

  it('gives the AI service a 60-second AI_INTERNAL link and a service token, and nothing else', async () => {
    const { ids } = await submitted();
    await h.process(ids.PAN);
    const call = h.aiClient.calls[0];
    expect(call).toMatchObject({ type: 'PAN', documentId: ids.PAN });
    expect(call?.signedUrl).toMatch(/^http:\/\/localhost:4000\/files\/[A-Za-z0-9_-]{75}$/);
    expect(call?.signedUrl).not.toContain(ids.PAN);
    const issue = h.documentStore.issues.at(-1);
    expect(issue).toMatchObject({ purpose: 'AI_INTERNAL', issuedToUserId: h.service.id });
    expect((issue?.expiresAt.getTime() ?? 0) - Date.parse('2026-10-09T10:00:00Z')).toBe(60_000);
  });
});

describe('failures and retries', () => {
  it('a transient failure is retried: the row stays PENDING and the attempt is recorded', async () => {
    const { ids } = await submitted();
    h.aiClient.respond = () => {
      throw unreachableAi();
    };
    const outcome = await h.process(ids.PAN, 1, 4);
    expect(outcome.kind).toBe('retry');
    expect(h.extractionStore.rows.get(ids.PAN)).toMatchObject({ status: 'PENDING', attempt: 1 });
    expect(h.audits.filter((x) => x.action === 'extraction.attempt_failed')).toHaveLength(1);
  });

  it('after the last attempt it writes ERROR, flags the session, holds it back, and tells the story in the audit log', async () => {
    const { ids } = await submitted();
    h.aiClient.respond = () => {
      throw unreachableAi();
    };
    expect((await h.process(ids.PAN, 1)).kind).toBe('retry');
    expect((await h.process(ids.PAN, 2)).kind).toBe('retry');
    expect((await h.process(ids.PAN, 3)).kind).toBe('retry');
    expect((await h.process(ids.PAN, 4)).kind).toBe('failed');

    const row = h.extractionStore.rows.get(ids.PAN);
    expect(row).toMatchObject({ status: 'ERROR', attempt: 4 });
    expect(row?.errorMessage).toContain('unreachable');
    expect(row?.completedAt).not.toBeNull();
    expect(h.kycStore.sessions[0]).toMatchObject({
      status: 'DOCS_UPLOADED',
      flags: ['EXTRACTION_ERROR'],
    });
    expect(
      h.actions().filter((x) => x.startsWith('extraction.') && x !== 'extraction.job_enqueued'),
    ).toEqual([
      'extraction.attempt_failed',
      'extraction.attempt_failed',
      'extraction.attempt_failed',
      'extraction.failed',
      'extraction.session_flagged',
    ]);

    // The other documents finishing does not release a session with a failed document.
    await h.process(ids.AADHAAR_FRONT);
    await h.process(ids.AADHAAR_BACK);
    expect(h.kycStore.sessions[0]?.status).toBe('DOCS_UPLOADED');
  });

  it('a permanent failure (HTTP 4xx) is not retried', async () => {
    const { ids } = await submitted();
    h.aiClient.respond = () => {
      throw new AiServiceError('AI service returned HTTP 422', false, 422);
    };
    expect((await h.process(ids.PAN, 1)).kind).toBe('failed');
    expect(h.extractionStore.rows.get(ids.PAN)).toMatchObject({ status: 'ERROR', attempt: 1 });
    expect(h.audits.filter((x) => x.action === 'extraction.attempt_failed')).toHaveLength(0);
  });

  it('a result for the wrong document or a contract violation is permanent', async () => {
    const { ids } = await submitted();
    h.aiClient.respond = () => {
      throw new AiServiceError('AI service response violated the contract', false);
    };
    expect((await h.process(ids.PAN)).kind).toBe('failed');
  });

  it('error text stored on the row is short and carries no document content', async () => {
    const { ids } = await submitted();
    h.aiClient.respond = () => {
      throw new Error('x'.repeat(5000));
    };
    await h.process(ids.PAN, 4, 4);
    expect((h.extractionStore.rows.get(ids.PAN)?.errorMessage ?? '').length).toBeLessThanOrEqual(
      300,
    );
  });
});

describe('queue processor', () => {
  const job = (documentId: string, attemptsMade = 0, attempts = 4) =>
    ({
      data: { documentId, kind: 'extract' },
      attemptsMade,
      opts: { attempts },
    }) as unknown as Job<ExtractJobData>;

  it('maps outcomes to BullMQ behaviour: return / throw (retry) / UnrecoverableError (stop)', async () => {
    const { ids } = await submitted();
    const processor = createVerificationProcessor(h.services.extraction, [10, 60, 300]);

    await expect(processor(job(ids.PAN))).resolves.toEqual({ status: 'OK' });
    await expect(processor(job(ids.PAN))).resolves.toMatchObject({
      skipped: expect.stringContaining('OK'),
    });

    h.aiClient.respond = () => {
      throw unreachableAi();
    };
    const retry = processor(job(ids.AADHAAR_FRONT, 0));
    await expect(retry).rejects.toThrow('unreachable');
    await expect(retry).rejects.not.toBeInstanceOf(UnrecoverableError);
    await expect(processor(job(ids.AADHAAR_BACK, 3))).rejects.toBeInstanceOf(UnrecoverableError); // 4th and last attempt
    expect(h.extractionStore.rows.get(ids.AADHAAR_BACK)?.status).toBe('ERROR');
  });

  it('retries after 10 s, 60 s and 300 s', () => {
    const delays = [10, 60, 300];
    expect([1, 2, 3].map((n) => backoffDelayMs(delays, n))).toEqual([10_000, 60_000, 300_000]);
  });
});

describe('AI_INTERNAL links through the file proxy', () => {
  async function internalLink() {
    const { ids } = await submitted();
    await h.process(ids.PAN);
    const call = h.aiClient.calls[0];
    if (!call) throw new Error('no call');
    return { ids, path: new URL(call.signedUrl).pathname, token: call.serviceToken };
  }

  it('serves the decrypted bytes to the service token and logs it as an AI view', async () => {
    const { path, token } = await internalLink();
    const res = await request(h.app)
      .get(path)
      .set('Authorization', `Bearer ${token}`)
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(res.status).toBe(200);
    expect((res.body as Buffer).length).toBe(4000);
    const viewed = h.audits.find((x) => x.action === 'document.viewed');
    expect(viewed).toMatchObject({ actorType: 'AI', actorId: h.service.id });
    expect(viewed?.metadata).toMatchObject({ purpose: 'AI_INTERNAL', bytesStreamed: 4000 });
  });

  it('refuses everyone else: no credential, a customer cookie, a customer bearer, or another user id', async () => {
    const { path } = await internalLink();
    expect((await request(h.app).get(path)).status).toBe(401);
    expect((await a.get(path)).status).toBe(401); // the customer's own cookie is not accepted for AI links
    const customer = h.store.users.find((u) => u.email === 'a@kycsetu.dev');
    const customerToken = await signToken(
      { userId: customer?.id ?? '', role: 'CUSTOMER' },
      { secret: testEnv().JWT_SECRET, expiresInSeconds: 60 },
    );
    expect(
      (await request(h.app).get(path).set('Authorization', `Bearer ${customerToken}`)).status,
    ).toBe(403);
    const otherService = await signToken(
      { userId: '7b1d3c5e-1111-4222-8333-444455556666', role: 'AI_SERVICE' },
      { secret: testEnv().JWT_SECRET, expiresInSeconds: 60 },
    );
    expect(
      (await request(h.app).get(path).set('Authorization', `Bearer ${otherService}`)).status,
    ).toBe(403);
    expect((await request(h.app).get(path).set('Authorization', 'Bearer garbage')).status).toBe(
      401,
    );
  });

  it('expires after 60 seconds', async () => {
    const { path, token } = await internalLink();
    h.setClock(new Date('2026-10-09T10:01:01Z'));
    expect((await request(h.app).get(path).set('Authorization', `Bearer ${token}`)).status).toBe(
      410,
    );
  });

  it('cannot be requested through the customer route', async () => {
    const { ids } = await submitted();
    const res = await a.get(`/kyc/documents/${ids.PAN}/signed-url?purpose=AI_INTERNAL`);
    expect(res.status).toBe(403);
    expect(h.documentStore.issues.filter((i) => i.purpose === 'AI_INTERNAL')).toHaveLength(0);
  });

  it('the service account can never log in', async () => {
    for (const realm of ['customer', 'officer']) {
      const res = await request(h.app)
        .post(`/auth/${realm}/login`)
        .send({ email: 'ai-service@kycsetu.internal', password: '!disabled' });
      expect(res.status).toBe(401);
    }
  });
});

describe('customer-facing extraction routes', () => {
  it('lists status and completion time only, never extracted values', async () => {
    const { sessionId, ids } = await submitted();
    await h.process(ids.PAN);
    const res = await a.get(`/kyc/sessions/${sessionId}/extractions`);
    expect(res.status).toBe(200);
    type Summary = { type: string; status: string; completedAt: string | null };
    const byType = Object.fromEntries(
      (res.body.extractions as Summary[]).map((e) => [e.type, e]),
    ) as Record<string, Summary>;
    const pan = byType['PAN'] as Summary;
    expect(pan).toMatchObject({ status: 'OK', documentId: ids.PAN });
    expect(pan.completedAt).toEqual(expect.any(String));
    expect(byType['AADHAAR_FRONT']).toMatchObject({ status: 'PENDING', completedAt: null });
    expect(byType['SIGNATURE']).toMatchObject({ status: 'SKIPPED' });
    expect(Object.keys(pan).sort()).toEqual(['completedAt', 'documentId', 'status', 'type']);
    for (const secret of ['ABCDE1234F', 'RAHUL', 'fields', 'rawText', 'panNumber'])
      expect(res.text).not.toContain(secret);
  });

  it('a customer who does not own the session gets 404 for the list and 403 for a single extraction', async () => {
    const { sessionId, ids } = await submitted();
    const b = await h.signedIn('b@kycsetu.dev');
    expect((await b.get(`/kyc/sessions/${sessionId}/extractions`)).status).toBe(404);
    expect((await b.get(`/kyc/documents/${ids.PAN}/extraction`)).status).toBe(403);
    expect(
      (await b.get('/kyc/documents/7b1d3c5e-1111-4222-8333-444455556666/extraction')).status,
    ).toBe(403);
    expect((await a.get(`/kyc/documents/${ids.PAN}/extraction`)).body.extraction).toMatchObject({
      status: 'PENDING',
    });
    expect((await request(h.app).get(`/kyc/documents/${ids.PAN}/extraction`)).status).toBe(401);
  });
});

describe('dev debug route', () => {
  it('needs an officer login and shows decrypted fields with the Aadhaar number redacted everywhere', async () => {
    const { ids } = await submitted();
    h.aiClient.respond = (req) =>
      aiResponse(req.type, req.documentId, {
        rawText:
          req.type === 'PAN' ? 'ABCDE1234F\nRAHUL' : 'Aadhaar 2341 2341 4321 and 234123414321 end',
      });
    await h.process(ids.PAN);
    await h.process(ids.AADHAAR_FRONT);

    expect((await request(h.app).get(`/dev/extractions/${ids.PAN}`)).status).toBe(401);
    expect((await a.get(`/dev/extractions/${ids.PAN}`)).status).toBe(401); // a customer session isn't an officer session

    const officer = await h.signedIn('officer@kycsetu.dev', 'officer');
    const pan = (await officer.get(`/dev/extractions/${ids.PAN}`)).body.extraction;
    expect(pan.fields.panNumber.value).toBe('ABCDE1234F');
    expect(pan.fields.name.value).toBe('RAHUL KUMAR SHARMA');
    expect(pan.rawText).toContain('ABCDE1234F');

    const front = await officer.get(`/dev/extractions/${ids.AADHAAR_FRONT}`);
    expect(front.body.extraction.rawText).toBe('Aadhaar XXXX XXXX 4321 and XXXX XXXX 4321 end');
    expect(front.text).not.toMatch(/2341\s?2341\s?4321|234123414321/);
    expect(
      (await officer.get(`/dev/extractions/7b1d3c5e-1111-4222-8333-444455556666`)).status,
    ).toBe(404);
  });

  it('is not registered at all in production', async () => {
    const prod = await createHarness({ NODE_ENV: 'production', KMS_PROVIDER: 'aws' });
    const { ids } = await (async () => {
      const agent = await prod.signedIn('a@kycsetu.dev');
      return prod
        .withDocuments(agent)
        .catch(() => ({ ids: { PAN: '7b1d3c5e-1111-4222-8333-444455556666' } }));
    })();
    const officer = await prod.signedIn('officer@kycsetu.dev', 'officer');
    expect((await officer.get(`/dev/extractions/${ids.PAN}`)).status).toBe(404);
  });
});

describe('helpers', () => {
  it('redactAadhaar hides all but the last four digits, in any spacing, and leaves other numbers alone', () => {
    expect(redactAadhaar('2341 2341 4321')).toBe('XXXX XXXX 4321');
    expect(redactAadhaar('2341-2341-4321')).toBe('XXXX XXXX 4321');
    expect(redactAadhaar('234123414321')).toBe('XXXX XXXX 4321');
    expect(redactAadhaar('PIN 560038, phone 9876543210')).toBe('PIN 560038, phone 9876543210');
    expect(redactAadhaar('0123 4567 8901')).toBe('0123 4567 8901'); // Aadhaar numbers never start with 0 or 1
  });

  it('the PAN blind index is deterministic, case-insensitive and key-dependent', () => {
    const k1 = Buffer.alloc(32, 1);
    const k2 = Buffer.alloc(32, 2);
    expect(panBlindIndex('ABCDE1234F', k1)).toBe(panBlindIndex(' abcde1234f ', k1));
    expect(panBlindIndex('ABCDE1234F', k1)).not.toBe(panBlindIndex('ABCDE1234F', k2));
    expect(panBlindIndex('ABCDE1234F', k1)).not.toBe(panBlindIndex('ABCDE1234G', k1));
    expect(panBlindIndex('ABCDE1234F', k1)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('the retention sweeper deletes only raw text older than the cutoff', async () => {
    const { ids } = await submitted();
    await h.process(ids.PAN);
    await h.process(ids.AADHAAR_FRONT);
    const old = h.extractionStore.rows.get(ids.PAN);
    if (old) old.completedAt = new Date('2026-06-01T00:00:00Z');
    const swept = await sweepExpiredRawText(
      h.extractionStore,
      90,
      new Date('2026-10-09T00:00:00Z'),
    );
    expect(swept).toBe(1);
    expect(h.extractionStore.rows.get(ids.PAN)?.rawTextEncrypted).toBeNull();
    expect(h.extractionStore.rows.get(ids.AADHAAR_FRONT)?.rawTextEncrypted).not.toBeNull();
    expect(h.extractionStore.rows.get(ids.PAN)?.status).toBe('OK'); // only the raw text goes
  });
});
