import { readFileSync } from 'node:fs';
import { Router } from 'express';
import { z } from 'zod';
import { extractResponseSchema, type ExtractResponse } from '@kyc-setu/shared';
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
 */
export function createAiMockRouter(deps: { env: Pick<Env, 'AI_INTERNAL_KEY'> }): Router {
  const router = Router();
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
  return router;
}
