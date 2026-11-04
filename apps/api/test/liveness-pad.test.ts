import { beforeEach, describe, expect, it } from 'vitest';
import { registry } from '../src/observability/metrics.js';
import { makeJpeg } from './fixtures.js';
import { motionResponse, padResponse } from './helpers.js';
import { createHarness, type Agent, type Harness } from './harness.js';

const frames = [makeJpeg(3000, 1), makeJpeg(3000, 2), makeJpeg(3000, 3)];

async function setup(method: 'MOTION_CHECK' | 'PASSIVE_PAD' | 'PASSIVE_PLUS_MOTION') {
  const h = await createHarness({ LIVENESS_METHOD: method });
  const customer = await h.signedIn('a@kycsetu.dev');
  const { sessionId } = await h.reachExtracted(customer);
  return { h, customer, sessionId };
}

/** The customer's selfie through the real route, then the worker's motion check, with the fake AI answering as scripted. */
async function takeSelfie(
  h: Harness,
  customer: Agent,
  sessionId: string,
  answers: {
    motion?: Parameters<typeof motionResponse>[1];
    pad: ReturnType<typeof padResponse> | null;
  },
) {
  h.aiClient.motion = (req) =>
    motionResponse(req.captureId, { ...answers.motion, pad: answers.pad });
  let req = customer.post(`/kyc/sessions/${sessionId}/selfie`);
  frames.forEach(
    (f, i) =>
      (req = req.attach(`frame${i}`, f, { filename: `f${i}.jpg`, contentType: 'image/jpeg' })),
  );
  const res = await req.attach('best', frames[1]!, {
    filename: 'b.jpg',
    contentType: 'image/jpeg',
  });
  expect(res.status).toBe(201);
  for (const job of h.enqueuer.selfieChecks.splice(0))
    await h.services.selfie.runMotionCheck(job.captureId);
  return h.selfieStore.liveness.at(-1)!;
}

const counter = async (name: string, labels: Record<string, string>) => {
  const metric = (await registry.getMetricsAsJSON()).find((m) => m.name === name);
  return (
    (metric?.values as { value: number; labels: Record<string, string> }[] | undefined)?.find((v) =>
      Object.entries(labels).every(([k, val]) => v.labels[k] === val),
    )?.value ?? 0
  );
};

describe('shadow mode (LIVENESS_METHOD=MOTION_CHECK, the default)', () => {
  let ctx: Awaited<ReturnType<typeof setup>>;
  beforeEach(async () => {
    ctx = await setup('MOTION_CHECK');
  });

  it('records the PAD result but lets the motion check alone decide, and counts the disagreement', async () => {
    const before = await counter('kyc_liveness_pad_comparisons_total', { agree: 'no' });
    const row = await takeSelfie(ctx.h, ctx.customer, ctx.sessionId, {
      pad: padResponse({
        score: 0.12,
        decision: 'SPOOF',
        subScores: { scale2_7: 0.05, scale4_0: 0.3 },
      }),
    });
    expect(row).toMatchObject({
      method: 'MOTION_CHECK',
      result: 'PASSED', // motion passed; the model's SPOOF is ignored
      failureReason: null,
      padScore: 0.12,
      padDecision: 'SPOOF',
      padThreshold: 0.5,
      padFailThreshold: 0.4,
      modelWeightsHash: 'a'.repeat(64),
    });
    expect(row.subScores).toMatchObject({
      scale2_7: 0.05,
      scale4_0: 0.3,
      decidedBy: 'MOTION_CHECK',
      configured: 'MOTION_CHECK',
    });
    expect(await counter('kyc_liveness_pad_comparisons_total', { agree: 'no' })).toBe(before + 1);
  });

  it('counts agreement too', async () => {
    const before = await counter('kyc_liveness_pad_comparisons_total', { agree: 'yes' });
    await takeSelfie(ctx.h, ctx.customer, ctx.sessionId, { pad: padResponse() });
    expect(await counter('kyc_liveness_pad_comparisons_total', { agree: 'yes' })).toBe(before + 1);
  });

  it('asks the service with the thresholds it holds and says which method it will decide with', async () => {
    await takeSelfie(ctx.h, ctx.customer, ctx.sessionId, { pad: padResponse() });
    expect(ctx.h.aiClient.motionCalls.at(-1)).toMatchObject({
      padPassThreshold: 0.5,
      padFailThreshold: 0.4,
      mode: 'MOTION_CHECK',
    });
  });

  it('works against a service that sends no PAD result at all', async () => {
    const row = await takeSelfie(ctx.h, ctx.customer, ctx.sessionId, { pad: null });
    expect(row).toMatchObject({
      method: 'MOTION_CHECK',
      result: 'PASSED',
      padScore: null,
      padDecision: null,
      subScores: null,
    });
  });
});

describe('PASSIVE_PLUS_MOTION', () => {
  it('fails a session where PAD fails even though the motion check passed', async () => {
    const { h, customer, sessionId } = await setup('PASSIVE_PLUS_MOTION');
    const row = await takeSelfie(h, customer, sessionId, {
      pad: padResponse({ score: 0.1, decision: 'SPOOF' }),
    });
    expect(row).toMatchObject({
      method: 'PASSIVE_PLUS_MOTION',
      result: 'FAILED',
      failureReason: 'PAD_SPOOF',
      padDecision: 'SPOOF',
    });
    expect((await customer.get(`/kyc/sessions/${sessionId}/selfie/status`)).body.liveness).toEqual({
      status: 'FAILED',
      failureReason: 'PAD_SPOOF',
    });
  });

  it('passes when both pass, and when PAD is only borderline', async () => {
    for (const pad of [padResponse(), padResponse({ score: 0.45, decision: 'BORDERLINE' })]) {
      const { h, customer, sessionId } = await setup('PASSIVE_PLUS_MOTION');
      const row = await takeSelfie(h, customer, sessionId, { pad });
      expect(row).toMatchObject({ method: 'PASSIVE_PLUS_MOTION', result: 'PASSED' });
    }
  });

  it('degrades to the motion check alone when PAD timed out, and records that honestly', async () => {
    const { h, customer, sessionId } = await setup('PASSIVE_PLUS_MOTION');
    const row = await takeSelfie(h, customer, sessionId, {
      pad: padResponse({
        score: null,
        decision: 'UNAVAILABLE',
        reason: 'TIMED_OUT',
        subScores: {},
        modelWeightsHash: null,
      }),
    });
    expect(row).toMatchObject({
      method: 'MOTION_CHECK',
      result: 'PASSED',
      padScore: null,
      padDecision: 'UNAVAILABLE',
    });
    expect(row.subScores).toMatchObject({
      pad_timed_out: true,
      degraded: true,
      configured: 'PASSIVE_PLUS_MOTION',
    });
  });

  it('writes liveness.pad_evaluated with the method and the sub-scores, and never a picture or an embedding', async () => {
    const { h, customer, sessionId } = await setup('PASSIVE_PLUS_MOTION');
    await takeSelfie(h, customer, sessionId, { pad: padResponse() });
    const entry = h.audits.find((a) => a.action === 'liveness.pad_evaluated')!;
    expect(entry.metadata).toMatchObject({
      sessionId,
      method: 'PASSIVE_PLUS_MOTION',
      outcome: 'LIVE',
      padScore: 0.82,
      modelVersion: 'minifasnet-v2-2.7+v1se-4.0:test',
      subScores: { scale2_7: 0.75, scale4_0: 0.9 },
    });
    expect(JSON.stringify(entry.metadata)).not.toMatch(/embedding|crop|frame|png|jpeg/i);
  });
});

describe('PASSIVE_PAD', () => {
  it('lets the model decide alone', async () => {
    const { h, customer, sessionId } = await setup('PASSIVE_PAD');
    const row = await takeSelfie(h, customer, sessionId, {
      motion: { result: 'FAILED', failureReason: 'FRAMES_TOO_SIMILAR' },
      pad: padResponse(),
    });
    expect(row).toMatchObject({ method: 'PASSIVE_PAD', result: 'PASSED' });
  });
});
