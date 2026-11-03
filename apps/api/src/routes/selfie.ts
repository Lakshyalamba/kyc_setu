import busboy from 'busboy';
import { Router, type Request, type RequestHandler } from 'express';
import {
  MAX_DOCUMENT_BYTES,
  SELFIE_FRAME_COUNT,
  selfieStatusResponseSchema,
  selfieUploadResponseSchema,
  sessionIdParamsSchema,
  okResponseSchema,
} from '@kyc-setu/shared';
import { AppError, unauthorized } from '../lib/errors.js';
import { route } from '../lib/route.js';
import type { RequestMeta } from '../modules/kyc/kyc.service.js';
import type { SelfieService, SelfieUpload } from '../modules/selfie/selfie.service.js';

const userIdOf = (req: Request): string => {
  if (!req.auth) throw unauthorized();
  return req.auth.userId;
};
const metaOf = (req: Request): RequestMeta => ({
  ip: req.ip ?? null,
  userAgent: req.get('user-agent') ?? null,
});

const FRAME_FIELDS = ['frame0', 'frame1', 'frame2'] as const;

/**
 * Reads the multipart body into memory (four small JPEGs, or one picture for the fallback) and decides which it is:
 * `frame0..frame2` + `best` is the motion-check capture; a lone `file` is the file-upload fallback, which gets no motion check.
 * The user agent comes from the request header, not from anything the client claims.
 */
function readSelfieUpload(req: Request): Promise<SelfieUpload> {
  return new Promise((resolve, reject) => {
    let bb: busboy.Busboy;
    try {
      bb = busboy({
        headers: req.headers,
        limits: { files: 5, fields: 6, fieldSize: 64, fileSize: MAX_DOCUMENT_BYTES + 1 },
      });
    } catch {
      return reject(
        new AppError(400, 'MALFORMED_MULTIPART', 'Expected a multipart/form-data upload'),
      );
    }
    const files = new Map<string, Buffer>();
    const fields = new Map<string, string>();
    let tooLarge = false;
    bb.on('field', (name, value) => fields.set(name, value));
    bb.on('file', (name, stream) => {
      const chunks: Buffer[] = [];
      stream.on('data', (c: Buffer) => chunks.push(c));
      stream.on('limit', () => (tooLarge = true));
      stream.on('end', () => files.set(name, Buffer.concat(chunks)));
    });
    bb.on('filesLimit', () => reject(new AppError(400, 'TOO_MANY_FILES', 'Too many pictures')));
    bb.on('error', () => reject(new AppError(400, 'MALFORMED_MULTIPART', 'Malformed upload')));
    bb.on('close', () => {
      if (tooLarge) return reject(new AppError(413, 'FILE_TOO_LARGE', 'A picture is too large'));
      const width = Number(fields.get('screenWidth') ?? 0);
      const height = Number(fields.get('screenHeight') ?? 0);
      const deviceMeta = {
        userAgent: (req.get('user-agent') ?? '').slice(0, 300),
        screen: {
          width: Number.isFinite(width) ? Math.max(0, Math.trunc(width)) : 0,
          height: Number.isFinite(height) ? Math.max(0, Math.trunc(height)) : 0,
        },
      };
      const frames = FRAME_FIELDS.map((f) => files.get(f));
      const best = files.get('best');
      const lone = files.get('file');
      if (frames.every(Boolean) && best) {
        return resolve({ method: 'MOTION_CHECK', frames: frames as Buffer[], best, deviceMeta });
      }
      if (lone && frames.every((f) => !f) && !best)
        return resolve({ method: 'NONE', image: lone, deviceMeta });
      reject(
        new AppError(
          400,
          'INVALID_SELFIE_PARTS',
          `Send frame0, frame1, frame2 and best (${SELFIE_FRAME_COUNT} frames and the best one), or a single file.`,
        ),
      );
    });
    req.pipe(bb);
  });
}

/** The customer's selfie routes, mounted under /kyc. Customer authentication is applied by the caller. */
export function createSelfieRouter(deps: {
  selfie: SelfieService;
  requireCustomer: RequestHandler[];
}): Router {
  const { selfie } = deps;
  const router = Router();
  router.use(...deps.requireCustomer);

  const handleUpload =
    (mode: 'first' | 'retake'): RequestHandler =>
    async (req, res) => {
      const params = sessionIdParamsSchema.parse(req.params);
      const input = await readSelfieUpload(req);
      const out = await selfie.upload(userIdOf(req), params.id, input, metaOf(req), mode);
      res.status(201).json(selfieUploadResponseSchema.parse(out));
    };
  router.post('/sessions/:id/selfie', handleUpload('first'));
  router.post('/sessions/:id/selfie/retake', handleUpload('retake'));

  router.get(
    '/sessions/:id/selfie/status',
    route({ params: sessionIdParamsSchema, response: selfieStatusResponseSchema }, (ctx) =>
      selfie.status(userIdOf(ctx.req), ctx.params.id),
    ),
  );

  router.post(
    '/sessions/:id/selfie/continue',
    route({ params: sessionIdParamsSchema, response: okResponseSchema }, async (ctx) => {
      await selfie.confirm(userIdOf(ctx.req), ctx.params.id, metaOf(ctx.req));
      return { ok: true as const };
    }),
  );
  return router;
}
