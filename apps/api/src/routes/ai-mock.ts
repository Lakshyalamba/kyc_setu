import { readFileSync } from 'node:fs';
import { Router } from 'express';
import { z } from 'zod';
import {
  extractResponseSchema,
  faceMatchRequestSchema,
  faceMatchResponseSchema,
  motionCheckRequestSchema,
  motionCheckResponseSchema,
  type ExtractResponse,
} from '@kyc-setu/shared';
import type { Env } from '../config/env.js';
import { AppError } from '../lib/errors.js';
import { route } from '../lib/route.js';

const CONTRACTS = new URL('../../../../contracts/', import.meta.url);
const contract = (name: string): ExtractResponse =>
  extractResponseSchema.parse(JSON.parse(readFileSync(new URL(name, CONTRACTS), 'utf8')));

const requestSchema = z.object({
  documentId: z.string().uuid(),
  sessionId: z.string().uuid(),
  signedUrl: z.string(),
  documentType: z.enum(['AADHAAR_FRONT', 'AADHAAR_BACK']).optional(),
});

/**
 * A stand-in for the OCR service, for the load script and for running the stack without the AI container. It answers
 * the same two calls (`/extract/pan`, `/extract/aadhaar`) and `/readyz` with the canned responses in contracts/, never
 * fetches the document, and takes no time. Point AI_SERVICE_URL at `<api>/dev/ai-mock`. Development only: it is mounted
 * where the other /dev routes are, so it does not exist in production.
 *
 * It also answers `/face/liveness` and `/face/match`. It looks at no pixels: the answers come from `POST /face/config`
 * (a score and whether the motion check passes), defaulting to a clear match that passes. That is what lets an end-to-end
 * run exercise the selfie step without a face model; it says nothing about how the real models behave.
 */
export function createAiMockRouter(deps: { env: Pick<Env, 'AI_INTERNAL_KEY'> }): Router {
  const router = Router();
  const face = { score: 0.85, motionPasses: true };
  const samples = {
    PAN: () => contract('extract-pan.ok.json'),
    AADHAAR_FRONT: () => contract('extract-aadhaar-front.ok.json'),
    AADHAAR_BACK: () => contract('extract-aadhaar-back.ok.json'),
  };

  router.get('/readyz', (_req, res) => {
    res.json({ status: 'ok', service: 'ai-mock' });
  });

  const answer = (type: keyof typeof samples) =>
    route({ body: requestSchema, response: extractResponseSchema }, async (ctx) => {
      // The real service refuses callers without the shared secret; the mock keeps that behaviour.
      if (ctx.req.get('x-internal-key') !== deps.env.AI_INTERNAL_KEY)
        throw new AppError(401, 'INVALID_INTERNAL_KEY', 'invalid internal key');
      const kind = type === 'PAN' ? 'PAN' : (ctx.body.documentType ?? 'AADHAAR_FRONT');
      return { ...samples[kind](), documentId: ctx.body.documentId };
    });
  router.post('/extract/pan', answer('PAN'));
  router.post('/extract/aadhaar', answer('AADHAAR_FRONT'));

  const authorised = (req: { get(name: string): string | undefined }) => {
    if (req.get('x-internal-key') !== deps.env.AI_INTERNAL_KEY)
      throw new AppError(401, 'INVALID_INTERNAL_KEY', 'invalid internal key');
  };
  router.post(
    '/face/config',
    route(
      {
        body: z.object({ score: z.number().min(0).max(1), motionPasses: z.boolean() }),
        response: z.object({ ok: z.literal(true) }),
      },
      async (ctx) => {
        authorised(ctx.req);
        Object.assign(face, ctx.body);
        return { ok: true as const };
      },
    ),
  );
  router.post(
    '/face/liveness',
    route({ body: motionCheckRequestSchema, response: motionCheckResponseSchema }, async (ctx) => {
      authorised(ctx.req);
      const ok = face.motionPasses;
      return {
        captureId: ctx.body.captureId,
        method: 'MOTION_CHECK' as const,
        result: ok ? ('PASSED' as const) : ('FAILED' as const),
        failureReason: ok ? null : ('FRAMES_TOO_SIMILAR' as const),
        metrics: {
          ssimPairs: ok ? [0.55, 0.5] : [0.995, 0.996],
          meanSsim: ok ? 0.525 : 0.9955,
          boxIouPairs: [0.93, 0.9],
          facesPerFrame: [1, 1, 1],
          sharpness: 50,
          brightness: 150,
        },
        modelVersion: 'ai-mock',
      };
    }),
  );
  router.post(
    '/face/match',
    route({ body: faceMatchRequestSchema, response: faceMatchResponseSchema }, async (ctx) => {
      authorised(ctx.req);
      return {
        selfieCaptureId: ctx.body.selfieCaptureId,
        idDocumentId: ctx.body.idDocumentId,
        score: face.score,
        embeddingVersion: 'ai-mock',
        reason: null,
        idFaceCropPng: null,
        selfieFaceCropPng: null,
        idEmbedding: null,
        selfieEmbedding: null,
      };
    }),
  );
  return router;
}
