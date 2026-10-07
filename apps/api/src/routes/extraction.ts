import { Router, type Request, type RequestHandler } from 'express';
import { z } from 'zod';
import {
  extractionListResponseSchema,
  extractionResponseSchema,
  sessionDocumentParamsSchema,
  sessionIdParamsSchema,
} from '@kyc-setu/shared';
import { unauthorized } from '../lib/errors.js';
import { route } from '../lib/route.js';
import type { PermissionGuards } from '../middleware/permission.js';
import type { ExtractionService } from '../modules/extraction/extraction.service.js';

const userIdOf = (req: Request): string => {
  if (!req.auth) throw unauthorized();
  return req.auth.userId;
};

/** Customer-facing: status and completion time only. The extracted values are for officers. */
export function createExtractionRouter(deps: {
  extraction: ExtractionService;
  requireCustomer: RequestHandler[];
}): Router {
  const { extraction } = deps;
  const router = Router();
  router.use(...deps.requireCustomer);

  router.get(
    '/sessions/:id/extractions',
    route(
      { params: sessionIdParamsSchema, response: extractionListResponseSchema },
      async (ctx) => ({
        extractions: await extraction.summaryForSession(userIdOf(ctx.req), ctx.params.id),
      }),
    ),
  );

  router.get(
    '/documents/:docId/extraction',
    route(
      {
        params: sessionDocumentParamsSchema.pick({ docId: true }),
        response: extractionResponseSchema,
      },
      async (ctx) => ({
        extraction: await extraction.summaryForDocument(userIdOf(ctx.req), ctx.params.docId),
      }),
    ),
  );

  return router;
}

/**
 * DEV ONLY. app.ts registers this only when NODE_ENV !== 'production'. Officer login required.
 * Returns everything stored for tuning the parsers; Aadhaar numbers in the raw text are redacted.
 */
export function createDevExtractionRouter(deps: {
  extraction: ExtractionService;
  guard: PermissionGuards;
}): Router {
  const router = Router();
  router.get(
    '/extractions/:documentId',
    // Shows the decrypted PAN for parser tuning, so it is for the roles that may see identifiers, not the auditor.
    deps.guard.require('kyc.session.reveal_pii'),
    route(
      {
        params: z.object({ documentId: z.string().uuid() }),
        response: z.object({ extraction: z.record(z.string(), z.unknown()) }),
      },
      async (ctx) => ({ extraction: await deps.extraction.debugView(ctx.params.documentId) }),
    ),
  );
  return router;
}
