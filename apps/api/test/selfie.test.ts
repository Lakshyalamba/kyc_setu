import { beforeEach, describe, expect, it } from 'vitest';
import { makeJpeg, makePng } from './fixtures.js';
import { matchResponse } from './helpers.js';
import { createHarness, type Agent, type Harness } from './harness.js';

let h: Harness;
let customer: Agent;
let sessionId: string;

const frames = [makeJpeg(3000, 1), makeJpeg(3000, 2), makeJpeg(3000, 3)];
const attach = (r: ReturnType<Agent['post']>, over: Record<string, Buffer | null> = {}) => {
  const parts: Record<string, Buffer | null> = {
    frame0: frames[0]!,
    frame1: frames[1]!,
    frame2: frames[2]!,
    best: frames[1]!, // the middle frame, by position
    ...over,
  };
  for (const [name, bytes] of Object.entries(parts))
    if (bytes) r = r.attach(name, bytes, { filename: `${name}.jpg`, contentType: 'image/jpeg' });
  return r.field('screenWidth', '390').field('screenHeight', '844');
};
const upload = (over: Record<string, Buffer | null> = {}, path = 'selfie') =>
  attach(customer.post(`/kyc/sessions/${sessionId}/${path}`), over);
const status = async () => (await customer.get(`/kyc/sessions/${sessionId}/selfie/status`)).body;
const sessionStatus = () => h.kycStore.sessions.find((s) => s.id === sessionId)!.status;

/** Runs the two queued checks the way the worker would. */
async function runChecks() {
  for (const job of h.enqueuer.selfieChecks.splice(0)) {
    if (job.motionCheck) await h.services.selfie.runMotionCheck(job.captureId);
    await h.services.selfie.runFaceMatch(job.captureId, job.idDocumentId);
  }
}

beforeEach(async () => {
  h = await createHarness();
  customer = await h.signedIn('a@kycsetu.dev');
  ({ sessionId } = await h.reachExtracted(customer));
});

describe('uploading a selfie', () => {
  it('stores three frames and the best one encrypted, moves the session on and queues both checks', async () => {
    expect(sessionStatus()).toBe('DOCS_EXTRACTED');
    const res = await upload();
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ livenessMethod: 'MOTION_CHECK' });
    expect(sessionStatus()).toBe('SELFIE_CAPTURED');

    const [capture] = h.selfieStore.captures;
    expect(capture).toMatchObject({
      sessionId,
      livenessMethod: 'MOTION_CHECK',
      replacedById: null,
    });
    expect(capture!.framesStorageKeys).toHaveLength(3);
    expect(capture!.frameEnvelopes).toHaveLength(4);
    expect(capture!.framesStorageKeys[0]).toMatch(
      new RegExp(`^sessions/${sessionId}/selfie/${capture!.id}/`),
    );
    expect(capture!.deviceMeta).toMatchObject({ screen: { width: 390, height: 844 } });
    // What is stored is ciphertext, never the picture.
    const stored = h.objectStore.objects.get(capture!.framesStorageKeys[0]!);
    expect(stored).toBeDefined();
    expect(Buffer.compare(stored!, frames[0]!)).not.toBe(0);

    expect(h.enqueuer.selfieChecks).toMatchObject([{ captureId: capture!.id, motionCheck: true }]);
    expect(h.actions()).toEqual(
      expect.arrayContaining(['selfie.captured', 'kyc.session.transitioned']),
    );
  });

  it('refuses a body that is not three frames and the middle one as best', async () => {
    expect((await upload({ frame2: null })).status).toBe(400);
    expect((await upload({ best: frames[0]! })).body.error.code).toBe('BEST_FRAME_MISMATCH');
    expect((await upload({ frame0: Buffer.from('not a picture at all') })).status).toBe(415);
    expect(h.selfieStore.captures).toHaveLength(0);
    expect(sessionStatus()).toBe('DOCS_EXTRACTED');
  });

  it('is not allowed before the documents have been read, and not for somebody else’s session', async () => {
    const other = await h.signedIn('b@kycsetu.dev');
    expect((await attach(other.post(`/kyc/sessions/${sessionId}/selfie`))).status).toBe(404);
    const fresh = await h.signedIn('b@kycsetu.dev');
    const id = (await fresh.post('/kyc/sessions')).body.session.id as string;
    expect((await attach(fresh.post(`/kyc/sessions/${id}/selfie`))).status).toBe(409);
  });

  it('needs a signed-in customer', async () => {
    const anon = await h.signedIn('nobody@kycsetu.dev');
    expect((await attach(anon.post(`/kyc/sessions/${sessionId}/selfie`))).status).toBe(401);
  });

  it('a second first-time upload is refused', async () => {
    await upload();
    const again = await upload({}, 'selfie');
    expect(again.status).toBe(409);
  });
});

describe('the file-upload fallback', () => {
  it('is accepted, recorded as NONE and gets no motion check', async () => {
    const res = await customer
      .post(`/kyc/sessions/${sessionId}/selfie`)
      .attach('file', makeJpeg(5000, 9), { filename: 'me.jpg', contentType: 'image/jpeg' });
    expect(res.status).toBe(201);
    expect(res.body.livenessMethod).toBe('NONE');
    expect(h.enqueuer.selfieChecks).toMatchObject([{ motionCheck: false }]);
    expect(h.actions()).toContain('selfie.fallback_used');
    await runChecks();
    expect(h.aiClient.motionCalls).toHaveLength(0);
    expect(await status()).toMatchObject({
      livenessMethod: 'NONE',
      liveness: { status: 'NOT_PERFORMED' },
      faceMatch: { status: 'DONE', decision: 'AUTO_PASS' },
    });
  });

  it('takes images only: a PDF is refused', async () => {
    const res = await customer
      .post(`/kyc/sessions/${sessionId}/selfie`)
      .attach('file', Buffer.from('%PDF-1.4\n%%EOF\n'), {
        filename: 'me.pdf',
        contentType: 'application/pdf',
      });
    expect(res.status).toBe(415);
  });

  it('mixing a lone file with frames is not a valid selfie', async () => {
    const res = await attach(customer.post(`/kyc/sessions/${sessionId}/selfie`), {
      best: null,
    }).attach('file', makePng(), { filename: 'x.png', contentType: 'image/png' });
    expect(res.status).toBe(400);
  });
});

describe('the checks', () => {
  it('the worker asks the AI service with 60-second signed links, and records both results', async () => {
    await upload();
    await runChecks();
    const [motion] = h.aiClient.motionCalls;
    expect(motion!.frameUrls).toHaveLength(3);
    for (const url of [...motion!.frameUrls, motion!.bestFrameUrl])
      expect(url).toMatch(/\/files\/[\w-]{40,}$/);
    expect(h.selfieStore.liveness).toMatchObject([{ method: 'MOTION_CHECK', result: 'PASSED' }]);
    expect(h.selfieStore.faceMatches).toMatchObject([
      {
        decision: 'AUTO_PASS',
        score: 0.8,
        threshold: 0.5,
        failThreshold: 0.3,
        embeddingVersion: 'fake-face-1',
      },
    ]);
    expect(h.actions()).toEqual(
      expect.arrayContaining([
        'selfie.motion_check_completed',
        'selfie.face_match_completed',
        'selfie.link_issued',
      ]),
    );
  });

  it('decides the face match from the shared thresholds, not from the service', async () => {
    for (const [score, expected] of [
      [0.9, 'AUTO_PASS'],
      [0.5, 'AUTO_PASS'],
      [0.4, 'REVIEW'],
      [0.3, 'REVIEW'],
      [0.29, 'AUTO_FAIL'],
    ] as const) {
      const fresh = await createHarness();
      const c = await fresh.signedIn('a@kycsetu.dev');
      const docs = await fresh.reachExtracted(c);
      fresh.aiClient.match = (req) =>
        matchResponse(req.selfieCaptureId, req.idDocumentId, { score });
      await attach(c.post(`/kyc/sessions/${docs.sessionId}/selfie`));
      for (const job of fresh.enqueuer.selfieChecks.splice(0))
        await fresh.services.selfie.runFaceMatch(job.captureId, job.idDocumentId);
      expect(fresh.selfieStore.faceMatches[0]!.decision, `score ${score}`).toBe(expected);
    }
  });

  it('a face that cannot be found is a failed match with its reason, and no crops are stored', async () => {
    h.aiClient.match = (req) =>
      matchResponse(req.selfieCaptureId, req.idDocumentId, {
        score: 0,
        reason: 'no_face_in_id',
        idFaceCropPng: null,
        selfieFaceCropPng: null,
        idEmbedding: null,
        selfieEmbedding: null,
      });
    await upload();
    await runChecks();
    expect(h.selfieStore.faceMatches[0]).toMatchObject({
      decision: 'AUTO_FAIL',
      reason: 'no_face_in_id',
      idFaceCropKey: null,
    });
  });

  it('keeps the crops and the embeddings encrypted', async () => {
    await upload();
    await runChecks();
    const m = h.selfieStore.faceMatches[0]!;
    expect(m.idEmbedding!.toString('utf8')).toMatch(/^enc:v1:/);
    expect(m.idEmbedding!.toString('utf8')).not.toContain('AAAAAA');
    const crop = h.objectStore.objects.get(m.idFaceCropKey!)!;
    expect(crop.subarray(0, 4).toString('hex')).not.toBe('89504e47'); // not a PNG: ciphertext
  });

  it('running a job twice records one result', async () => {
    await upload();
    const job = h.enqueuer.selfieChecks[0]!;
    await h.services.selfie.runMotionCheck(job.captureId);
    expect((await h.services.selfie.runMotionCheck(job.captureId)).kind).toBe('skipped');
    await h.services.selfie.runFaceMatch(job.captureId, job.idDocumentId);
    expect((await h.services.selfie.runFaceMatch(job.captureId, job.idDocumentId)).kind).toBe(
      'skipped',
    );
    expect(h.selfieStore.liveness).toHaveLength(1);
    expect(h.selfieStore.faceMatches).toHaveLength(1);
  });
});

describe('what the customer is told', () => {
  it('is pending until the checks finish, then the outcome, and never a score or a metric', async () => {
    await upload();
    expect(await status()).toMatchObject({
      liveness: { status: 'PENDING' },
      faceMatch: { status: 'PENDING', decision: null },
      canRetake: false,
    });
    await runChecks();
    const done = await status();
    expect(done).toMatchObject({
      liveness: { status: 'PASSED' },
      faceMatch: { status: 'DONE', decision: 'AUTO_PASS' },
    });
    const text = JSON.stringify(done).toLowerCase();
    for (const leak of ['score', 'ssim', 'metrics', 'embedding', 'threshold'])
      expect(text).not.toContain(leak);
  });

  it('says there is nothing yet before a selfie exists', async () => {
    expect(await status()).toMatchObject({ captureId: null, canRetake: false });
  });
});

describe('retaking', () => {
  async function failFirst() {
    h.aiClient.match = (req) =>
      matchResponse(req.selfieCaptureId, req.idDocumentId, { score: 0.1 });
    await upload();
    await runChecks();
  }

  it('is offered once after a failed comparison, replaces the capture and keeps the old row', async () => {
    await failFirst();
    expect(await status()).toMatchObject({
      faceMatch: { decision: 'AUTO_FAIL' },
      canRetake: true,
      retakesUsed: 0,
    });
    const first = h.selfieStore.captures[0]!;

    h.aiClient.match = (req) =>
      matchResponse(req.selfieCaptureId, req.idDocumentId, { score: 0.8 });
    const res = await upload({}, 'selfie/retake');
    expect(res.status).toBe(201);
    expect(h.selfieStore.captures).toHaveLength(2);
    expect(first.replacedById).toBe(h.selfieStore.captures[1]!.id);
    expect(h.selfieStore.captures[1]!.replacedById).toBeNull();
    expect(h.actions()).toContain('selfie.replaced');

    await runChecks();
    expect(await status()).toMatchObject({
      faceMatch: { decision: 'AUTO_PASS' },
      canRetake: false,
      retakesUsed: 1,
    });
  });

  it('is final after the one retake', async () => {
    await failFirst();
    await upload({}, 'selfie/retake');
    await runChecks();
    const res = await upload({}, 'selfie/retake');
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('SELFIE_RETAKE_USED');
  });

  it('is not needed once the selfie was accepted', async () => {
    await upload();
    await runChecks();
    const res = await upload({}, 'selfie/retake');
    expect(res.body.error.code).toBe('SELFIE_RETAKE_NOT_NEEDED');
  });

  it('a check that finishes for a replaced capture is ignored', async () => {
    await failFirst();
    const old = h.selfieStore.captures[0]!;
    await upload({}, 'selfie/retake');
    h.aiClient.motionCalls.length = 0;
    expect((await h.services.selfie.runMotionCheck(old.id)).kind).toBe('skipped');
    expect(h.aiClient.motionCalls).toHaveLength(0);
  });

  it('"continue" accepts the result as it is, once', async () => {
    await failFirst();
    expect((await customer.post(`/kyc/sessions/${sessionId}/selfie/continue`)).status).toBe(200);
    expect(await status()).toMatchObject({ canRetake: false });
    expect(h.actions()).toContain('selfie.confirmed');
    expect((await customer.post(`/kyc/sessions/${sessionId}/selfie/continue`)).status).toBe(409);
  });

  it('cannot be confirmed before the checks have finished', async () => {
    await upload();
    expect((await customer.post(`/kyc/sessions/${sessionId}/selfie/continue`)).status).toBe(409);
  });
});

describe('officer links to selfie objects', () => {
  it('serve a decrypted frame or crop to the officer they were issued to, and to nobody else', async () => {
    await upload();
    await runChecks();
    const capture = h.selfieStore.captures[0]!;
    const officer = await h.signedIn('officer@kycsetu.dev', 'officer');
    const other = await h.signedIn('officer2@kycsetu.dev', 'officer');
    const link = await h.services.selfie.issueOfficerLink(
      h.officers.one.id,
      capture.id,
      'crop:id',
      sessionId,
    );
    const path = new URL(link.url).pathname;

    const ok = await officer.get(path);
    expect(ok.status).toBe(200);
    expect(ok.headers['content-type']).toMatch(/image\/png/);
    expect(ok.headers['cache-control']).toBe('no-store');
    expect((await other.get(path)).status).toBe(403);
    expect((await customer.get(path)).status).toBe(401);
    expect(h.actions()).toContain('selfie.viewed');

    const frame = await h.services.selfie.issueOfficerLink(
      h.officers.one.id,
      capture.id,
      'frame:1',
      sessionId,
    );
    const f = await officer.get(new URL(frame.url).pathname);
    expect(f.status).toBe(200);
    expect(Buffer.compare(f.body, frames[1]!)).toBe(0);
  });
});
