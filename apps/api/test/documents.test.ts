import { randomBytes, randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import {
  createFakeAiClient,
  createFakeDocumentStore,
  createFakeEnqueuer,
  createFakeExtractionStore,
  createFakeKycStore,
  createFakeRiskStore,
  createFakeObjectStore,
  createFakeStore,
  testEnv,
  type FakeAiClient,
  type FakeDocumentStore,
  type FakeEnqueuer,
  type FakeExtractionStore,
  type FakeKycStore,
  type FakeObjectStore,
  type FakeStore,
} from './helpers.js';
import { makeJpeg, makePdf, makePng, sha256 } from './fixtures.js';

const healthy = async () => ({ database: 'up' as const, redis: 'up' as const, queue: null });
const PASSWORD = 'password123';

let store: FakeStore;
let kycStore: FakeKycStore;
let docStore: FakeDocumentStore;
let objects: FakeObjectStore;
let extractionStore: FakeExtractionStore;
let enqueuer: FakeEnqueuer;
let aiClient: FakeAiClient;
let clock: Date;

const build = () =>
  createApp({
    env: testEnv(),
    store,
    kycStore,
    documentStore: docStore,
    objectStore: objects,
    extractionStore: extractionStore,
    riskStore: createFakeRiskStore(store.audits),
    enqueuer,
    aiClient,
    healthProbe: healthy,
    kycOverrides: { now: () => clock },
  });

type Agent = ReturnType<typeof request.agent>;

async function signedIn(email: string): Promise<Agent> {
  const agent = request.agent(build());
  await agent.post('/auth/customer/login').send({ email, password: PASSWORD });
  return agent;
}

/** A session already at PERSONAL_SUBMITTED, i.e. where the documents step starts. */
async function atDocumentsStep(agent: Agent): Promise<string> {
  const id = (await agent.post('/kyc/sessions')).body.session.id as string;
  const s = kycStore.sessions.find((x) => x.id === id);
  if (!s) throw new Error('no session');
  Object.assign(s, {
    status: 'PERSONAL_SUBMITTED',
    currentStep: 'DOCUMENTS',
    completedSteps: ['CONTACT', 'CONSENT', 'PERSONAL'],
    consentVersionId: kycStore.consent.id,
  });
  return id;
}

const upload = (agent: Agent, id: string, type: string, file: Buffer, contentType: string) =>
  agent
    .post(`/kyc/sessions/${id}/documents`)
    .field('type', type)
    .attach('file', file, { filename: 'scan.bin', contentType });

const JPEG = makeJpeg();
const PNG = makePng();
const audits = () => store.audits;
const actions = () => audits().map((a) => a.action);

beforeEach(async () => {
  clock = new Date('2026-10-08T10:00:00Z');
  store = createFakeStore();
  kycStore = createFakeKycStore(store.audits);
  docStore = createFakeDocumentStore(store.audits);
  objects = createFakeObjectStore();
  extractionStore = createFakeExtractionStore(store.audits, kycStore, docStore);
  enqueuer = createFakeEnqueuer();
  aiClient = createFakeAiClient();
  await store.addUser('a@kycsetu.dev', PASSWORD, 'CUSTOMER');
  await store.addUser('b@kycsetu.dev', PASSWORD, 'CUSTOMER');
  await store.addUser('officer@kycsetu.dev', PASSWORD, 'OFFICER');
});

describe('upload', () => {
  it('stores an encrypted object, records the envelope, and audits metadata only', async () => {
    const a = await signedIn('a@kycsetu.dev');
    const id = await atDocumentsStep(a);
    const res = await upload(a, id, 'PAN', JPEG, 'image/jpeg');

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ type: 'PAN', sha256: sha256(JPEG) });
    expect(Object.keys(res.body).sort()).toEqual(['documentId', 'sha256', 'type', 'uploadedAt']);

    const key = `sessions/${id}/${res.body.documentId}.enc`;
    const stored = objects.objects.get(key);
    expect(stored).toBeDefined();
    expect(stored?.length).toBe(JPEG.length);
    expect(stored?.equals(JPEG)).toBe(false); // ciphertext, not the file
    expect(stored?.includes(JPEG.subarray(0, 8))).toBe(false);

    const row = docStore.documents[0];
    expect(row).toMatchObject({
      storageKey: key,
      mimeType: 'image/jpeg',
      sizeBytes: JPEG.length,
      kmsKeyId: 'local:v1',
    });
    expect(row?.iv).toHaveLength(12);
    expect(row?.authTag).toHaveLength(16);
    expect(row?.encryptedDataKey.length).toBe(60);

    const entry = audits().find((x) => x.action === 'document.uploaded');
    expect(entry?.metadata).toMatchObject({
      documentId: res.body.documentId,
      type: 'PAN',
      sha256: sha256(JPEG),
      sizeBytes: JPEG.length,
      mime: 'image/jpeg',
    });
    expect(JSON.stringify(audits())).not.toContain(JPEG.toString('base64').slice(0, 20));
  });

  it('accepts PNG and PDF for identity documents, and PNG for the signature', async () => {
    const a = await signedIn('a@kycsetu.dev');
    const id = await atDocumentsStep(a);
    expect((await upload(a, id, 'AADHAAR_BACK', PNG, 'image/png')).status).toBe(201);
    expect((await upload(a, id, 'AADHAAR_FRONT', makePdf(), 'application/pdf')).status).toBe(201);
    expect((await upload(a, id, 'SIGNATURE', PNG, 'image/png')).status).toBe(201);
  });

  it('is refused unless the session is at the documents step', async () => {
    const a = await signedIn('a@kycsetu.dev');
    const id = (await a.post('/kyc/sessions')).body.session.id as string; // still DRAFT
    const res = await upload(a, id, 'PAN', JPEG, 'image/jpeg');
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('INVALID_STATE');
    expect(objects.objects.size).toBe(0);
  });

  it("404s on someone else's session", async () => {
    const a = await signedIn('a@kycsetu.dev');
    const id = await atDocumentsStep(a);
    const b = await signedIn('b@kycsetu.dev');
    expect((await upload(b, id, 'PAN', JPEG, 'image/jpeg')).status).toBe(404);
    expect((await b.get(`/kyc/sessions/${id}/documents`)).status).toBe(404);
  });

  it('requires a customer session', async () => {
    const res = await request(build()).post(`/kyc/sessions/${randomUUID()}/documents`);
    expect(res.status).toBe(401);
  });

  describe('rejections (each writes document.upload_failed with a reason, never contents)', () => {
    const reasonOf = () =>
      audits()
        .filter((x) => x.action === 'document.upload_failed')
        .map((x) => x.metadata?.['reason']);

    it('sniffs the real type: text claiming to be a JPEG', async () => {
      const a = await signedIn('a@kycsetu.dev');
      const id = await atDocumentsStep(a);
      const res = await upload(
        a,
        id,
        'PAN',
        Buffer.from('just some text, not an image'),
        'image/jpeg',
      );
      expect(res.status).toBe(415);
      expect(res.body.error.code).toBe('UNSUPPORTED_MEDIA_TYPE');
      expect(reasonOf()).toEqual(['UNSUPPORTED_TYPE']);
      expect(objects.objects.size).toBe(0);
    });

    it('rejects when the declared type disagrees with the bytes', async () => {
      const a = await signedIn('a@kycsetu.dev');
      const id = await atDocumentsStep(a);
      const res = await upload(a, id, 'PAN', PNG, 'image/jpeg');
      expect(res.body.error.code).toBe('MIME_MISMATCH');
      expect(reasonOf()).toEqual(['MIME_MISMATCH']);
    });

    it('rejects SVG and a JPEG signature', async () => {
      const a = await signedIn('a@kycsetu.dev');
      const id = await atDocumentsStep(a);
      const svg = Buffer.from(
        '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
      );
      expect((await upload(a, id, 'PAN', svg, 'image/svg+xml')).status).toBe(415);
      expect((await upload(a, id, 'SIGNATURE', JPEG, 'image/jpeg')).status).toBe(415);
      expect(objects.objects.size).toBe(0);
    });

    it('rejects an invalid or late `type` field', async () => {
      const a = await signedIn('a@kycsetu.dev');
      const id = await atDocumentsStep(a);
      expect((await upload(a, id, 'PASSPORT', JPEG, 'image/jpeg')).body.error.code).toBe(
        'INVALID_TYPE_FIELD',
      );
      const late = await a
        .post(`/kyc/sessions/${id}/documents`)
        .attach('file', JPEG, { filename: 'x.jpg', contentType: 'image/jpeg' })
        .field('type', 'PAN');
      expect(late.status).toBe(400);
      expect(reasonOf()).toEqual(['INVALID_TYPE_FIELD', 'INVALID_TYPE_FIELD']);
    });

    it('rejects a request with no file, an empty file, and non-multipart bodies', async () => {
      const a = await signedIn('a@kycsetu.dev');
      const id = await atDocumentsStep(a);
      expect(
        (await a.post(`/kyc/sessions/${id}/documents`).field('type', 'PAN')).body.error.code,
      ).toBe('MISSING_FILE');
      expect((await upload(a, id, 'PAN', Buffer.alloc(0), 'image/jpeg')).status).toBe(400);
      expect((await a.post(`/kyc/sessions/${id}/documents`).send({ type: 'PAN' })).status).toBe(
        400,
      );
    });

    it('rejects an oversized request up front by Content-Length (nothing is stored)', async () => {
      const a = await signedIn('a@kycsetu.dev');
      const id = await atDocumentsStep(a);
      const big = Buffer.concat([makeJpeg(100), Buffer.alloc(6 * 1024 * 1024)]);
      // The server answers 413 and closes the connection before the client has written all 6 MB. Depending on
      // timing the client then sees the response, or EPIPE / ECONNRESET on the write. Both mean "rejected up front".
      const res = await upload(a, id, 'PAN', big, 'image/jpeg').catch(
        (err: NodeJS.ErrnoException) => {
          if (err.code === 'EPIPE' || err.code === 'ECONNRESET') return null;
          throw err;
        },
      );
      if (res) {
        expect(res.status).toBe(413);
        expect(res.body.error.code).toBe('FILE_TOO_LARGE');
      }
      expect(reasonOf()).toEqual(['TOO_LARGE']);
      expect(objects.objects.size).toBe(0);
    });

    it('enforces the 5 MB cap while streaming (file just over the limit, headers within slack)', async () => {
      const a = await signedIn('a@kycsetu.dev');
      const id = await atDocumentsStep(a);
      const justOver = Buffer.concat([makeJpeg(100), Buffer.alloc(5 * 1024 * 1024 + 1 - 100)]);
      const res = await upload(a, id, 'PAN', justOver, 'image/jpeg');
      expect(res.status).toBe(413);
      expect(reasonOf()).toEqual(['TOO_LARGE']);
      expect(objects.objects.size).toBe(0);
      expect(docStore.documents).toHaveLength(0);
    });

    it('accepts a file of exactly 5 MB', async () => {
      const a = await signedIn('a@kycsetu.dev');
      const id = await atDocumentsStep(a);
      const exact = makeJpeg(5 * 1024 * 1024);
      const res = await upload(a, id, 'PAN', exact, 'image/jpeg');
      expect(res.status).toBe(201);
      expect(res.body.sha256).toBe(sha256(exact));
    });
  });
});

describe('replace, delete, list', () => {
  it('replacing keeps history: old row points at the new one, nothing is deleted', async () => {
    const a = await signedIn('a@kycsetu.dev');
    const id = await atDocumentsStep(a);
    const first = await upload(a, id, 'AADHAAR_FRONT', makeJpeg(2048, 1), 'image/jpeg');
    const second = await upload(a, id, 'AADHAAR_FRONT', makePng(), 'image/png');
    expect(second.status).toBe(201);

    const list = await a.get(`/kyc/sessions/${id}/documents`);
    expect(list.body.documents).toHaveLength(1);
    expect(list.body.documents[0]).toMatchObject({
      id: second.body.documentId,
      mimeType: 'image/png',
    });

    const old = docStore.documents.find((d) => d.id === first.body.documentId);
    expect(old?.replacedById).toBe(second.body.documentId);
    expect(
      docStore.documents.find((d) => d.id === second.body.documentId)?.replacedById,
    ).toBeNull();
    expect(objects.objects.size).toBe(2); // old ciphertext retained
    expect(audits().find((x) => x.action === 'document.replaced')?.metadata).toEqual({
      oldDocumentId: first.body.documentId,
      newDocumentId: second.body.documentId,
      type: 'AADHAAR_FRONT',
    });
    expect(actions().filter((x) => x === 'document.uploaded')).toHaveLength(2);
  });

  it('DELETE soft-deletes (replacedById = self), keeps ciphertext, frees the slot, and audits', async () => {
    const a = await signedIn('a@kycsetu.dev');
    const id = await atDocumentsStep(a);
    const up = await upload(a, id, 'PAN', JPEG, 'image/jpeg');
    const docId = up.body.documentId as string;

    expect((await a.delete(`/kyc/sessions/${id}/documents/${docId}`)).body).toEqual({ ok: true });
    expect(docStore.documents[0]?.replacedById).toBe(docId);
    expect(objects.objects.size).toBe(1);
    expect((await a.get(`/kyc/sessions/${id}/documents`)).body.documents).toEqual([]);
    expect(actions()).toContain('document.deleted');
    // Already gone / unknown ids 404.
    expect((await a.delete(`/kyc/sessions/${id}/documents/${docId}`)).status).toBe(404);
    // The slot is free again.
    expect((await upload(a, id, 'PAN', JPEG, 'image/jpeg')).status).toBe(201);
  });

  it('cannot delete a document of another session', async () => {
    const a = await signedIn('a@kycsetu.dev');
    const idA = await atDocumentsStep(a);
    const up = await upload(a, idA, 'PAN', JPEG, 'image/jpeg');
    const b = await signedIn('b@kycsetu.dev');
    const idB = await atDocumentsStep(b);
    expect((await b.delete(`/kyc/sessions/${idB}/documents/${up.body.documentId}`)).status).toBe(
      404,
    );
    expect(docStore.documents[0]?.replacedById).toBeNull();
  });
});

describe('submit', () => {
  const allFour = async (a: Agent, id: string) => {
    await upload(a, id, 'PAN', JPEG, 'image/jpeg');
    await upload(a, id, 'AADHAAR_FRONT', makeJpeg(3000), 'image/jpeg');
    await upload(a, id, 'AADHAAR_BACK', PNG, 'image/png');
    await upload(a, id, 'SIGNATURE', PNG, 'image/png');
  };

  it('is refused until all four documents are present', async () => {
    const a = await signedIn('a@kycsetu.dev');
    const id = await atDocumentsStep(a);
    await upload(a, id, 'PAN', JPEG, 'image/jpeg');
    const res = await a.post(`/kyc/sessions/${id}/documents/submit`);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('DOCUMENTS_INCOMPLETE');
    expect(res.body.error.details.missing).toEqual(['AADHAAR_FRONT', 'AADHAAR_BACK', 'SIGNATURE']);
    expect(kycStore.sessions[0]?.status).toBe('PERSONAL_SUBMITTED');
  });

  it('transitions to DOCS_UPLOADED, moves to SELFIE, audits, and locks the documents', async () => {
    const a = await signedIn('a@kycsetu.dev');
    const id = await atDocumentsStep(a);
    await allFour(a, id);
    const res = await a.post(`/kyc/sessions/${id}/documents/submit`);
    expect(res.status).toBe(200);
    expect(res.body.session).toMatchObject({
      status: 'DOCS_UPLOADED',
      currentStep: 'SELFIE',
      completedSteps: ['CONTACT', 'CONSENT', 'PERSONAL', 'DOCUMENTS'],
    });
    expect(actions()).toEqual(
      expect.arrayContaining(['kyc.documents.submitted', 'kyc.session.transitioned']),
    );

    const docId = docStore.documents[0]?.id ?? '';
    expect((await upload(a, id, 'PAN', JPEG, 'image/jpeg')).status).toBe(409);
    expect((await a.delete(`/kyc/sessions/${id}/documents/${docId}`)).status).toBe(409);
    expect((await a.post(`/kyc/sessions/${id}/documents/submit`)).status).toBe(409);
  });

  it('a deleted document blocks submission', async () => {
    const a = await signedIn('a@kycsetu.dev');
    const id = await atDocumentsStep(a);
    await allFour(a, id);
    const sig = docStore.documents.find((d) => d.type === 'SIGNATURE');
    await a.delete(`/kyc/sessions/${id}/documents/${sig?.id}`);
    expect((await a.post(`/kyc/sessions/${id}/documents/submit`)).body.error.code).toBe(
      'DOCUMENTS_INCOMPLETE',
    );
  });
});

describe('signed URLs and the decryption proxy', () => {
  async function withDoc() {
    const a = await signedIn('a@kycsetu.dev');
    const id = await atDocumentsStep(a);
    const up = await upload(a, id, 'PAN', JPEG, 'image/jpeg');
    const docId = up.body.documentId as string;
    const issued = await a.get(`/kyc/documents/${docId}/signed-url`);
    return {
      a,
      id,
      docId,
      issued,
      path: issued.body.url ? new URL(issued.body.url as string).pathname : '',
    };
  }

  it('issues a 5-minute opaque URL and audits the grant', async () => {
    const { issued, docId } = await withDoc();
    expect(issued.status).toBe(200);
    expect(issued.body.purpose).toBe('CUSTOMER_PREVIEW');
    expect(new Date(issued.body.expiresAt).getTime() - clock.getTime()).toBe(300_000);
    expect(issued.body.url).toMatch(/^http:\/\/localhost:4000\/files\/[A-Za-z0-9_-]{75}$/);
    expect(issued.body.url).not.toContain(docId);
    const entry = audits().find((x) => x.action === 'document.signed_url_issued');
    expect(entry?.metadata).toMatchObject({ documentId: docId, purpose: 'CUSTOMER_PREVIEW' });
    expect(docStore.issues).toHaveLength(1);
  });

  it('serves the decrypted bytes with safe headers and writes document.viewed', async () => {
    const { a, path, docId } = await withDoc();
    const res = await a
      .get(path)
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(res.status).toBe(200);
    expect((res.body as Buffer).equals(JPEG)).toBe(true);
    expect(res.headers['content-type']).toBe('image/jpeg');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-security-policy']).toContain("default-src 'none'");
    expect(res.headers['cross-origin-resource-policy']).toBe('cross-origin');
    expect(res.headers['etag']).toBeUndefined();
    const viewed = audits().find((x) => x.action === 'document.viewed');
    expect(viewed?.metadata).toMatchObject({ documentId: docId, bytesStreamed: JPEG.length });
  });

  it("another customer can't issue a URL for my document (403), nor use my URL", async () => {
    const { path, docId } = await withDoc();
    const b = await signedIn('b@kycsetu.dev');
    const issue = await b.get(`/kyc/documents/${docId}/signed-url`);
    expect(issue.status).toBe(403);
    expect(docStore.issues).toHaveLength(1); // only A's

    const steal = await b.get(path);
    expect(steal.status).toBe(403);
    expect(actions().filter((x) => x === 'document.viewed')).toHaveLength(0);
    // Unknown document ids look the same (no existence oracle).
    expect((await b.get(`/kyc/documents/${randomUUID()}/signed-url`)).status).toBe(403);
  });

  it('requires the owner to be signed in, even with a valid URL', async () => {
    const { path } = await withDoc();
    expect((await request(build()).get(path)).status).toBe(401);
  });

  it('customers cannot request OFFICER_REVIEW', async () => {
    const { a, docId } = await withDoc();
    const res = await a.get(`/kyc/documents/${docId}/signed-url?purpose=OFFICER_REVIEW`);
    expect(res.status).toBe(403);
    expect((await a.get(`/kyc/documents/${docId}/signed-url?purpose=BOGUS`)).status).toBe(400);
  });

  it('expires after 5 minutes (410)', async () => {
    const { a, path } = await withDoc();
    clock = new Date(clock.getTime() + 301_000);
    const res = await a.get(path);
    expect(res.status).toBe(410);
    expect(res.body.error.code).toBe('LINK_EXPIRED');
  });

  it('rejects forged, tampered and malformed tokens identically (404)', async () => {
    const { a, path } = await withDoc();
    const token = path.split('/').pop() ?? '';
    const bytes = Buffer.from(token, 'base64url');
    bytes[30] = (bytes[30] ?? 0) ^ 1;
    expect((await a.get(`/files/${bytes.toString('base64url')}`)).status).toBe(404);
    // Fully forged: random id + MAC with a valid future expiry.
    const forged = Buffer.concat([randomBytes(16), Buffer.alloc(8), randomBytes(32)]);
    forged.writeBigUInt64BE(BigInt(clock.getTime() + 60_000), 16);
    expect((await a.get(`/files/${forged.toString('base64url')}`)).status).toBe(404);
    expect((await a.get('/files/not-a-token')).status).toBe(404);
  });

  it('a replaced or deleted document can no longer be fetched through an old URL', async () => {
    const { a, id, path } = await withDoc();
    await upload(a, id, 'PAN', makePng(), 'image/png'); // replaces the previewed one
    expect((await a.get(path)).status).toBe(404);
  });

  it('refuses to release bytes if the stored ciphertext was tampered with', async () => {
    const { a, path } = await withDoc();
    const [key] = [...objects.objects.keys()];
    const stored = objects.objects.get(key ?? '');
    if (!stored || !key) throw new Error('no object');
    stored[5] = (stored[5] ?? 0) ^ 0xff;
    const res = await a.get(path);
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('DOCUMENT_INTEGRITY_ERROR');
    expect(res.headers['content-type']).toMatch(/json/);
    expect(actions()).toContain('document.integrity_failed');
    expect(actions()).not.toContain('document.viewed');
  });
});
