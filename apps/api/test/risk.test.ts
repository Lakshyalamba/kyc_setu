import request from 'supertest';
import { UnrecoverableError, type Job } from 'bullmq';
import { beforeEach, describe, expect, it } from 'vitest';
import { encryptPii } from '@kyc-setu/shared/pii';
import { panBlindIndex } from '../src/modules/extraction/pii.js';
import type { VerificationJobData } from '../src/queue/verification.js';
import { createVerificationProcessor } from '../src/workers/verification.js';
import { aiResponse } from './helpers.js';
import { createHarness, type Agent, type Harness } from './harness.js';

let h: Harness;
let a: Agent;
let officer: Agent;

const GOOD = { faceMatch: { score: 0.92, modelVersion: 'test-1' }, liveness: { passed: true } };

beforeEach(async () => {
  h = await createHarness();
  a = await h.signedIn('a@kycsetu.dev');
  officer = await h.signedIn('officer@kycsetu.dev', 'officer');
});

/** Customer finishes documents -> extracted; then the (dev) injector supplies the selfie signals; then the worker runs. */
async function assess(opts: { typed?: Record<string, unknown>; biometrics?: typeof GOOD } = {}) {
  const docs = await h.reachExtracted(a, opts.typed);
  const inject = await officer
    .post(`/dev/sessions/${docs.sessionId}/biometrics`)
    .send(opts.biometrics ?? GOOD);
  expect(inject.status).toBe(200);
  const outcomes = await h.runQueuedRisk();
  const assessment = await h.riskStore.latestAssessment(docs.sessionId);
  return { ...docs, inject, outcomes, assessment };
}
const fired = (a: { triggeredRules: unknown } | null) =>
  (a?.triggeredRules as { ruleId: string }[] | undefined)?.map((t) => t.ruleId) ?? [];

describe('exit criterion 1: a clean flow', () => {
  it('produces a LOW assessment with nothing triggered, and the session ends UNDER_REVIEW', async () => {
    const { sessionId, assessment, inject, outcomes } = await assess();
    expect(inject.body).toEqual({ enqueued: true });
    expect(outcomes).toHaveLength(1);
    expect(assessment).toMatchObject({
      band: 'LOW',
      score: 0,
      hardFail: false,
      trigger: 'AUTO',
      triggeredById: null,
      engineVersion: '1.0.0',
    });
    expect(assessment?.triggeredRules).toEqual([]);
    expect(h.kycStore.sessions.find((s) => s.id === sessionId)?.status).toBe('UNDER_REVIEW');
  });

  it('records both SELFIE_CAPTURED -> SUBMITTED and SUBMITTED -> UNDER_REVIEW as persisted transitions', async () => {
    const { sessionId } = await assess();
    const moves = h.audits
      .filter((x) => x.action === 'kyc.session.transitioned' && x.entityId === sessionId)
      .map((x) => `${(x.metadata as { from: string }).from}>${(x.metadata as { to: string }).to}`);
    expect(moves.slice(-3)).toEqual([
      'DOCS_EXTRACTED>SELFIE_CAPTURED',
      'SELFIE_CAPTURED>SUBMITTED',
      'SUBMITTED>UNDER_REVIEW',
    ]);
  });

  it('audits job_enqueued and evaluated, with no PII and no field values', async () => {
    const { sessionId, assessment } = await assess();
    const enq = h.audits.filter((x) => x.action === 'risk.job_enqueued');
    const evald = h.audits.filter((x) => x.action === 'risk.evaluated');
    expect(enq).toHaveLength(1);
    expect(evald).toHaveLength(1);
    expect(evald[0]).toMatchObject({ entityId: sessionId, actorType: 'SYSTEM' });
    expect(Object.keys(evald[0]?.metadata ?? {}).sort()).toEqual([
      'assessmentId',
      'band',
      'engineVersion',
      'hardFail',
      'ruleCount',
      'score',
      'trigger',
    ]);
    expect(evald[0]?.metadata).toMatchObject({
      score: 0,
      band: 'LOW',
      engineVersion: '1.0.0',
      ruleCount: 17,
      hardFail: false,
      assessmentId: assessment?.id,
    });
    const dump = JSON.stringify(h.audits.filter((x) => x.action.startsWith('risk.')));
    for (const secret of ['RAHUL', 'ABCDE1234F', '234123414321', '1990-05-15', 'XXXX-XXXX'])
      expect(dump).not.toContain(secret);
  });

  it('stores an input summary with derived numbers only', async () => {
    const { assessment } = await assess();
    const snapshot = JSON.stringify(assessment?.inputsSnapshot);
    for (const secret of ['RAHUL', 'Rahul', 'ABCDE1234F', '234123414321', '1990-05-15'])
      expect(snapshot).not.toContain(secret);
    expect(assessment?.inputsSnapshot).toMatchObject({
      nameSimilarity: { panVsAadhaar: 1, formVsPan: 1 },
      comparisons: { panTypedMatchesExtracted: true, aadhaarTypedMatchesExtracted: true },
      faceMatch: { score: 0.92 },
    });
  });
});

describe('exit criteria 2-5: the scenarios', () => {
  it('2. a different face: HIGH, with face-match-below-threshold on top', async () => {
    const { assessment } = await assess({
      biometrics: { faceMatch: { score: 0.18, modelVersion: 't' }, liveness: { passed: true } },
    });
    expect(assessment).toMatchObject({ band: 'HIGH', rawBand: 'MEDIUM', score: 35 });
    expect(fired(assessment)[0]).toBe('face-match-below-threshold');
    expect(assessment?.bandFloors).toEqual([
      { ruleId: 'face-match-below-threshold', band: 'HIGH' },
    ]);
  });

  it('3. one wrong character in the typed PAN: MEDIUM, pan-form-mismatch', async () => {
    const { assessment } = await assess({ typed: { panNumber: 'ABCDE1234G' } });
    expect(assessment).toMatchObject({ band: 'MEDIUM', score: 20 });
    expect(fired(assessment)).toEqual(['pan-form-mismatch']);
  });

  it('3b. a wrong typed Aadhaar digit: MEDIUM, aadhaar-form-mismatch', async () => {
    const { assessment } = await assess({ typed: { aadhaarNumber: '234123414322' } });
    expect(fired(assessment)).toEqual(['aadhaar-form-mismatch']);
    expect(assessment?.band).toBe('MEDIUM');
  });

  it('4. the PAN of a prior APPROVED session of another user: HIGH, duplicate-pan-approved', async () => {
    h.riskStore.priors.push({
      sessionId: '7b1d3c5e-0000-4000-8000-000000000001',
      userId: '7b1d3c5e-0000-4000-8000-000000000002',
      panNumberHmac: panBlindIndex('ABCDE1234F', h.piiKey),
      aadhaarNumberLast4: '9999',
      typedAadhaarEncrypted: null,
    });
    const { assessment } = await assess();
    expect(assessment).toMatchObject({ band: 'HIGH', rawBand: 'MEDIUM', score: 40 });
    expect(fired(assessment)).toEqual(['duplicate-pan-approved']);
  });

  it("4b. the customer's own earlier approved session is not a duplicate", async () => {
    const me = h.store.users.find((u) => u.email === 'a@kycsetu.dev');
    h.riskStore.priors.push({
      sessionId: '7b1d3c5e-0000-4000-8000-000000000001',
      userId: me?.id ?? '',
      panNumberHmac: panBlindIndex('ABCDE1234F', h.piiKey),
      aadhaarNumberLast4: '4321',
      typedAadhaarEncrypted: null,
    });
    const { assessment } = await assess();
    expect(assessment?.band).toBe('LOW');
  });

  it('4c. a duplicate Aadhaar needs last-4 AND the full number to match', async () => {
    const prior = (typed: string) => ({
      sessionId: '7b1d3c5e-0000-4000-8000-000000000003',
      userId: '7b1d3c5e-0000-4000-8000-000000000002',
      panNumberHmac: null,
      aadhaarNumberLast4: '4321',
      typedAadhaarEncrypted: encryptPii(typed, h.piiKey),
    });
    h.riskStore.priors.push(prior('999999994321')); // same last four, different person
    const coincidence = await assess();
    expect(fired(coincidence.assessment)).toEqual([]);

    h.riskStore.priors.length = 0;
    h.riskStore.priors.push(prior('234123414321')); // the same Aadhaar
    const b = await h.signedIn('b@kycsetu.dev');
    const docs = await h.reachExtracted(b);
    await officer.post(`/dev/sessions/${docs.sessionId}/biometrics`).send(GOOD);
    await h.runQueuedRisk();
    const dup = await h.riskStore.latestAssessment(docs.sessionId);
    expect(dup).toMatchObject({ band: 'HIGH' });
    expect(fired(dup)).toEqual(['duplicate-aadhaar-approved']);
  });

  it('5. a document showing someone under 18: HIGH and hardFail, whatever else is true', async () => {
    h.aiClient.respond = (req) => {
      const r = aiResponse(req.type, req.documentId);
      if (r.fields.dob) r.fields.dob.value = '2012-01-01';
      return r;
    };
    const { assessment } = await assess();
    expect(assessment).toMatchObject({ band: 'HIGH', hardFail: true });
    expect(fired(assessment)).toContain('age-ineligible');
    expect(h.audits.find((x) => x.action === 'risk.evaluated')?.metadata).toMatchObject({
      hardFail: true,
      band: 'HIGH',
    });
  });

  it('a wrong document is never LOW (skipped rules do not look like a pass)', async () => {
    h.aiClient.respond = (req) =>
      req.type === 'AADHAAR_FRONT'
        ? aiResponse('AADHAAR_FRONT', req.documentId, {
            status: 'wrong_document',
            fields: {},
            rawText: '',
          })
        : aiResponse(req.type, req.documentId);
    const { assessment } = await assess();
    expect(assessment?.band).toBe('MEDIUM');
    expect(fired(assessment)).toEqual(['extraction-unusable']);
    expect((assessment?.skippedRules as { ruleId: string }[]).map((r) => r.ruleId)).toContain(
      'aadhaar-form-mismatch',
    );
  });
});

describe('triggering and idempotency', () => {
  it('does not queue the job until BOTH face match and liveness exist', async () => {
    const docs = await h.reachExtracted(a);
    const session = h.kycStore.sessions.find((s) => s.id === docs.sessionId);
    if (session) session.status = 'SELFIE_CAPTURED';
    await h.riskStore.recordBiometrics(
      {
        sessionId: docs.sessionId,
        source: 'DEV_INJECTED',
        faceMatchScore: 0.9,
        faceMatchModel: 't',
        livenessPassed: null,
      },
      (b) => ({
        actorId: null,
        actorType: 'SYSTEM',
        action: 'x',
        entityType: 'KycSession',
        entityId: b.sessionId,
        metadata: {},
      }),
    ); // fmt: skip
    expect(await h.services.risk.onInputsChanged(docs.sessionId)).toBe(false);
    expect(h.enqueuer.riskQueued).toEqual([]);
    expect(h.actions()).not.toContain('risk.job_enqueued');
  });

  it('does not queue before the selfie step (session not at SELFIE_CAPTURED)', async () => {
    const docs = await h.reachExtracted(a);
    expect(await h.services.risk.isReady(docs.sessionId)).toBe(false);
  });

  it('running the job twice assesses once', async () => {
    const { sessionId } = await assess();
    expect(await h.services.risk.runAutomatic(sessionId)).toMatchObject({ kind: 'skipped' });
    expect(h.riskStore.assessments.filter((x) => x.sessionId === sessionId)).toHaveLength(1);
  });

  it('a retry after a crash between the two transitions finishes the job without a second assessment', async () => {
    const { sessionId } = await assess();
    const s = h.kycStore.sessions.find((x) => x.id === sessionId);
    if (s) s.status = 'SUBMITTED'; // as if we crashed right after SELFIE_CAPTURED -> SUBMITTED
    const out = await h.services.risk.runAutomatic(sessionId);
    expect(out).toMatchObject({ kind: 'assessed', finalStatus: 'UNDER_REVIEW' });
    expect(s?.status).toBe('UNDER_REVIEW');
    expect(h.riskStore.assessments.filter((x) => x.sessionId === sessionId)).toHaveLength(1);
  });

  it('the queue processor runs the risk job, and a final failure leaves an audit row and a flag', async () => {
    const docs = await h.reachExtracted(a);
    await officer.post(`/dev/sessions/${docs.sessionId}/biometrics`).send(GOOD);
    const processor = createVerificationProcessor(
      h.services.extraction,
      [10, 60, 300],
      h.services.risk,
    );
    const job = (attemptsMade: number) =>
      ({
        data: { kind: 'risk', sessionId: docs.sessionId },
        attemptsMade,
        opts: { attempts: 4 },
      }) as unknown as Job<VerificationJobData>;

    const original = h.riskStore.latestBiometrics;
    h.riskStore.latestBiometrics = async () => {
      throw new Error('database is down');
    };
    await expect(processor(job(0))).rejects.toThrow('database is down'); // will be retried
    expect(h.actions()).not.toContain('risk.failed');
    await expect(processor(job(3))).rejects.toThrow('database is down'); // 4th and last attempt
    expect(h.actions()).toContain('risk.failed');
    expect(h.kycStore.sessions.find((s) => s.id === docs.sessionId)?.flags).toContain('RISK_ERROR');

    h.riskStore.latestBiometrics = original;
    h.kycStore.sessions.forEach(
      (s) => (s.status = s.id === docs.sessionId ? 'SELFIE_CAPTURED' : s.status),
    );
    await expect(processor(job(0))).resolves.toMatchObject({ band: 'LOW', status: 'UNDER_REVIEW' });
  });

  it('a risk job without a risk service on the worker is a permanent failure', async () => {
    const processor = createVerificationProcessor(h.services.extraction, [10]);
    const job = {
      data: { kind: 'risk', sessionId: 'x' },
      attemptsMade: 0,
      opts: { attempts: 2 },
    } as unknown as Job<VerificationJobData>;
    await expect(processor(job)).rejects.toBeInstanceOf(UnrecoverableError);
  });

  it('production ignores dev-injected signals entirely', async () => {
    // Production cookies are Secure, so drive the stores directly instead of logging in over plain HTTP.
    const prod = await createHarness({ NODE_ENV: 'production', KMS_PROVIDER: 'aws' });
    const userId = prod.store.users.find((u) => u.email === 'a@kycsetu.dev')?.id ?? '';
    const session = await prod.kycStore.createSession(
      { userId, expiresAt: new Date('2027-01-01') },
      (s) => ({
        actorId: userId,
        actorType: 'USER',
        action: 'kyc.session.created',
        entityType: 'KycSession',
        entityId: s.id,
        metadata: {},
      }),
    ); // fmt: skip
    if (!session) throw new Error('no session');
    session.status = 'SELFIE_CAPTURED';
    await prod.riskStore.recordBiometrics(
      {
        sessionId: session.id,
        source: 'DEV_INJECTED',
        faceMatchScore: 0.9,
        faceMatchModel: 't',
        livenessPassed: true,
      },
      (b) => ({
        actorId: null,
        actorType: 'SYSTEM',
        action: 'x',
        entityType: 'KycSession',
        entityId: b.sessionId,
        metadata: {},
      }),
    ); // fmt: skip
    expect(await prod.services.risk.isReady(session.id)).toBe(false);
    await expect(
      prod.services.risk.injectBiometrics('o', session.id, {
        faceMatch: { score: 0.9, modelVersion: 'x' },
        liveness: { passed: true },
      }),
    ).rejects.toMatchObject({ status: 404 });

    // A real pipeline signal, by contrast, counts.
    await prod.riskStore.recordBiometrics(
      {
        sessionId: session.id,
        source: 'PIPELINE',
        faceMatchScore: 0.9,
        faceMatchModel: 't',
        livenessPassed: true,
      },
      (b) => ({
        actorId: null,
        actorType: 'SYSTEM',
        action: 'x',
        entityType: 'KycSession',
        entityId: b.sessionId,
        metadata: {},
      }),
    ); // fmt: skip
    expect(await prod.services.risk.isReady(session.id)).toBe(true);
  });
});

describe('exit criterion 6: recompute', () => {
  it('writes a NEW row, records who and what changed, and leaves the session where it is', async () => {
    const { sessionId } = await assess();
    expect(h.riskStore.assessments).toHaveLength(1);
    // The facts change (e.g. a better selfie after a resubmission would, here a worse one).
    await h.riskStore.recordBiometrics(
      {
        sessionId,
        source: 'DEV_INJECTED',
        faceMatchScore: 0.2,
        faceMatchModel: 't',
        livenessPassed: true,
      },
      (b) => ({
        actorId: null,
        actorType: 'SYSTEM',
        action: 'x',
        entityType: 'KycSession',
        entityId: b.sessionId,
        metadata: {},
      }),
    ); // fmt: skip

    const res = await officer.post(`/kyc/sessions/${sessionId}/risk/recompute`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ bandChanged: true, previous: { band: 'LOW', score: 0 } });
    expect(res.body.assessment).toMatchObject({ band: 'HIGH', trigger: 'RECOMPUTE' });

    expect(h.riskStore.assessments).toHaveLength(2); // the first row is untouched
    expect(h.riskStore.assessments[0]).toMatchObject({ band: 'LOW', trigger: 'AUTO' });
    expect(h.kycStore.sessions.find((s) => s.id === sessionId)?.status).toBe('UNDER_REVIEW');

    const officerId = h.store.users.find((u) => u.email === 'officer@kycsetu.dev')?.id;
    const entry = h.audits.find((x) => x.action === 'risk.recomputed');
    expect(entry).toMatchObject({ actorId: officerId, actorType: 'USER', entityId: sessionId });
    expect(entry?.metadata).toMatchObject({
      previousBand: 'LOW',
      newBand: 'HIGH',
      previousScore: 0,
      newScore: 35,
      bandChanged: true,
      addedRules: ['face-match-below-threshold'],
      removedRules: [],
    }); // fmt: skip
  });

  it('reports no band change when nothing moved', async () => {
    const { sessionId } = await assess();
    const res = await officer.post(`/kyc/sessions/${sessionId}/risk/recompute`);
    expect(res.body).toMatchObject({ bandChanged: false, previous: { band: 'LOW' } });
    expect(h.audits.find((x) => x.action === 'risk.recomputed')?.metadata).toMatchObject({
      bandChanged: false,
      addedRules: [],
      removedRules: [],
    });
  });

  it('needs the decide permission: customers 403, an auditor (read-only) 403, no session 401', async () => {
    const { sessionId } = await assess();
    const asCustomer = await a.post(`/kyc/sessions/${sessionId}/risk/recompute`);
    expect(asCustomer.status).toBe(403);
    expect(asCustomer.body.error.details.permission).toBe('kyc.session.decide');
    const auditor = await h.signedIn('auditor@kycsetu.dev', 'officer');
    expect((await auditor.post(`/kyc/sessions/${sessionId}/risk/recompute`)).status).toBe(403);
    expect((await request(h.app).post(`/kyc/sessions/${sessionId}/risk/recompute`)).status).toBe(
      401,
    );
    expect(h.riskStore.assessments).toHaveLength(1);
  });
});

describe('reading an assessment', () => {
  it('officers (and auditors) see everything', async () => {
    const { sessionId } = await assess({
      biometrics: { faceMatch: { score: 0.7, modelVersion: 't' }, liveness: { passed: true } },
    });
    for (const who of [officer, await h.signedIn('auditor@kycsetu.dev', 'officer')]) {
      const res = await who.get(`/kyc/sessions/${sessionId}/risk`);
      expect(res.status).toBe(200);
      expect(res.body.assessment).toMatchObject({
        band: 'MEDIUM',
        score: 15,
        engineVersion: '1.0.0',
      });
      expect(res.body.assessment.triggeredRules[0]).toMatchObject({
        ruleId: 'face-match-borderline',
        penalty: 15,
        category: 'biometric',
      });
    }
  });

  it('the owning customer sees the band and nothing else', async () => {
    const { sessionId } = await assess({
      biometrics: { faceMatch: { score: 0.7, modelVersion: 't' }, liveness: { passed: true } },
    });
    const res = await a.get(`/kyc/sessions/${sessionId}/risk`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ band: 'MEDIUM' });
    for (const hidden of ['score', 'triggeredRules', 'face-match', 'engineVersion', 'reason'])
      expect(res.text).not.toContain(hidden);
  });

  it('another customer gets 404, an anonymous caller 401, and a session with no assessment 404', async () => {
    const { sessionId } = await assess();
    const b = await h.signedIn('b@kycsetu.dev');
    expect((await b.get(`/kyc/sessions/${sessionId}/risk`)).status).toBe(404);
    expect((await request(h.app).get(`/kyc/sessions/${sessionId}/risk`)).status).toBe(401);
    const fresh = (await b.post('/kyc/sessions')).body.session.id as string;
    expect((await b.get(`/kyc/sessions/${fresh}/risk`)).status).toBe(404);
    expect((await officer.get(`/kyc/sessions/${fresh}/risk`)).body.error.code).toBe(
      'NO_RISK_ASSESSMENT',
    );
  });

  it('returns the newest assessment after a recompute', async () => {
    const { sessionId } = await assess();
    await h.riskStore.recordBiometrics(
      {
        sessionId,
        source: 'DEV_INJECTED',
        faceMatchScore: 0.2,
        faceMatchModel: 't',
        livenessPassed: true,
      },
      (b) => ({
        actorId: null,
        actorType: 'SYSTEM',
        action: 'x',
        entityType: 'KycSession',
        entityId: b.sessionId,
        metadata: {},
      }),
    ); // fmt: skip
    await officer.post(`/kyc/sessions/${sessionId}/risk/recompute`);
    expect((await officer.get(`/kyc/sessions/${sessionId}/risk`)).body.assessment).toMatchObject({
      band: 'HIGH',
      trigger: 'RECOMPUTE',
    });
    expect((await a.get(`/kyc/sessions/${sessionId}/risk`)).body).toEqual({ band: 'HIGH' });
  });
});

describe('dev routes', () => {
  it('preview runs the engine on current data and persists nothing', async () => {
    const docs = await h.reachExtracted(a);
    await h.riskStore.recordBiometrics(
      {
        sessionId: docs.sessionId,
        source: 'DEV_INJECTED',
        faceMatchScore: 0.3,
        faceMatchModel: 't',
        livenessPassed: false,
      },
      (b) => ({
        actorId: null,
        actorType: 'SYSTEM',
        action: 'x',
        entityType: 'KycSession',
        entityId: b.sessionId,
        metadata: {},
      }),
    ); // fmt: skip
    const res = await officer.get(`/dev/risk/preview?sessionId=${docs.sessionId}`);
    expect(res.status).toBe(200);
    expect(res.body.result).toMatchObject({ band: 'HIGH', engineVersion: '1.0.0' });
    expect(res.body.result.triggeredRules.map((t: { ruleId: string }) => t.ruleId)).toEqual([
      'face-match-below-threshold',
      'liveness-failed',
    ]);
    expect(JSON.stringify(res.body.inputs)).not.toMatch(/RAHUL|ABCDE1234F|1990-05-15/);
    expect(h.riskStore.assessments).toEqual([]);
    expect(h.actions()).not.toContain('risk.evaluated');
    // Same data, same answer, byte for byte.
    expect(
      JSON.stringify((await officer.get(`/dev/risk/preview?sessionId=${docs.sessionId}`)).body),
    ).toBe(JSON.stringify(res.body));
  });

  it('require an officer; customers cannot use them', async () => {
    const docs = await h.reachExtracted(a);
    expect((await a.get(`/dev/risk/preview?sessionId=${docs.sessionId}`)).status).toBe(403);
    expect((await a.post(`/dev/sessions/${docs.sessionId}/biometrics`).send(GOOD)).status).toBe(
      403,
    );
    expect((await officer.get('/dev/risk/preview?sessionId=nope')).status).toBe(400);
  });

  it('the injector only works at DOCS_EXTRACTED / SELFIE_CAPTURED, and audits what it did', async () => {
    const early = (await a.post('/kyc/sessions')).body.session.id as string;
    expect((await officer.post(`/dev/sessions/${early}/biometrics`).send(GOOD)).status).toBe(409);
    const { sessionId } = await assess();
    expect((await officer.post(`/dev/sessions/${sessionId}/biometrics`).send(GOOD)).status).toBe(
      409,
    ); // already UNDER_REVIEW
    const row = h.audits.find((x) => x.action === 'dev.biometrics_injected');
    expect(row?.metadata).toMatchObject({
      source: 'DEV_INJECTED',
      faceMatchScore: 0.92,
      livenessPassed: true,
    });
  });

  it('are not registered in production', async () => {
    const prod = await createHarness({ NODE_ENV: 'production', KMS_PROVIDER: 'aws' });
    const o = await prod.signedIn('officer@kycsetu.dev', 'officer');
    expect(
      (await o.get('/dev/risk/preview?sessionId=7b1d3c5e-0000-4000-8000-000000000001')).status,
    ).toBe(404);
    expect(
      (await o.post('/dev/sessions/7b1d3c5e-0000-4000-8000-000000000001/biometrics').send(GOOD))
        .status,
    ).toBe(404);
  });
});
