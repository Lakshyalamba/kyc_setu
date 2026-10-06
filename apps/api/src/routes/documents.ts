import busboy from 'busboy';
import { Router, type Request, type RequestHandler } from 'express';
import {
  MAX_DOCUMENT_BYTES,
  MULTIPART_OVERHEAD_BYTES,
  documentListResponseSchema,
  documentTypeSchema,
  documentUploadResponseSchema,
  fileTokenParamsSchema,
  kycSessionResponseSchema,
  okResponseSchema,
  sessionDocumentParamsSchema,
  sessionIdParamsSchema,
  signedUrlQuerySchema,
  signedUrlResponseSchema,
  type DocumentType,
  type DocumentUploadResponse,
} from '@kyc-setu/shared';
import type { Env } from '../config/env.js';
import { cookieName } from '../lib/cookies.js';
import { AppError, forbidden, unauthorized } from '../lib/errors.js';
import { verifyToken } from '../lib/jwt.js';
import { route } from '../lib/route.js';
import {
  UploadFailure,
  toDocumentDto,
  type DocumentsService,
} from '../modules/documents/documents.service.js';
import type { RequestMeta } from '../modules/kyc/kyc.service.js';

const metaOf = (req: Request): RequestMeta => ({
  ip: req.ip ?? null,
  userAgent: req.get('user-agent') ?? null,
});

const userIdOf = (req: Request): string => {
  if (!req.auth) throw unauthorized();
  return req.auth.userId;
};

/**
 * Reads exactly one file part, streaming it into the service. The `type` field must precede the
 * file part so the allowed content types are known before any bytes are encrypted.
 */
function parseUpload(
  req: Request,
  handle: (input: {
    type: DocumentType;
    declaredMime: string;
    file: NodeJS.ReadableStream;
  }) => Promise<DocumentUploadResponse>,
): Promise<DocumentUploadResponse> {
  return new Promise((resolve, reject) => {
    let bb: busboy.Busboy;
    try {
      bb = busboy({
        headers: req.headers,
        limits: { files: 1, fields: 3, parts: 4, fieldSize: 64, fileSize: MAX_DOCUMENT_BYTES + 1 },
      });
    } catch {
      return reject(
        new UploadFailure(
          400,
          'MALFORMED_MULTIPART',
          'Expected a multipart/form-data upload',
          'MALFORMED_MULTIPART',
        ),
      );
    }
    let typeField: string | undefined;
    let sawFile = false;

    bb.on('field', (name, value) => {
      if (name === 'type') typeField = value;
    });
    bb.on('file', (name, file, info) => {
      sawFile = true;
      const parsedType = documentTypeSchema.safeParse(typeField);
      if (name !== 'file' || !parsedType.success) {
        file.resume();
        return reject(
          new UploadFailure(
            400,
            'INVALID_TYPE_FIELD',
            "Send a 'type' field (PAN, AADHAAR_FRONT, AADHAAR_BACK or SIGNATURE) before the 'file' part",
            'INVALID_TYPE_FIELD',
          ),
        );
      }
      handle({ type: parsedType.data, declaredMime: info.mimeType, file }).then(resolve, reject);
    });
    bb.on('filesLimit', () =>
      reject(
        new UploadFailure(
          400,
          'TOO_MANY_FILES',
          'Upload one file at a time',
          'MALFORMED_MULTIPART',
        ),
      ),
    );
    bb.on('partsLimit', () =>
      reject(
        new UploadFailure(400, 'MALFORMED_MULTIPART', 'Too many form parts', 'MALFORMED_MULTIPART'),
      ),
    );
    bb.on('error', () =>
      reject(
        new UploadFailure(400, 'MALFORMED_MULTIPART', 'Malformed upload', 'MALFORMED_MULTIPART'),
      ),
    );
    bb.on('close', () => {
      if (!sawFile) {
        reject(
          new UploadFailure(400, 'MISSING_FILE', "No 'file' part in the upload", 'MISSING_FILE'),
        );
      }
    });
    req.pipe(bb);
  });
}

/** Customer-authenticated document routes, mounted under /kyc. */
export function createDocumentsRouter(deps: {
  docs: DocumentsService;
  requireCustomer: RequestHandler[];
}): Router {
  const { docs } = deps;
  const router = Router();
  router.use(...deps.requireCustomer);

  router.post('/sessions/:id/documents', async (req, res) => {
    const { id } = sessionIdParamsSchema.parse(req.params);
    const userId = userIdOf(req);
    const meta = metaOf(req);
    // Authorise and check state BEFORE reading a single byte of the body.
    const session = await docs.prepareUpload(userId, id);

    let typeForAudit: string | undefined;
    try {
      const declared = Number(req.headers['content-length']);
      if (declared > MAX_DOCUMENT_BYTES + MULTIPART_OVERHEAD_BYTES) {
        throw new UploadFailure(413, 'FILE_TOO_LARGE', 'Files can be at most 5 MB', 'TOO_LARGE');
      }
      const result = await parseUpload(req, (input) => {
        typeForAudit = input.type;
        return docs.upload(userId, session, { ...input, file: input.file as never }, meta);
      });
      res.status(201).json(documentUploadResponseSchema.parse(result));
    } catch (err) {
      const failure =
        err instanceof UploadFailure
          ? err
          : err instanceof AppError
            ? null
            : new UploadFailure(502, 'STORAGE_ERROR', 'Could not store the file', 'STORAGE_ERROR');
      if (failure) await docs.recordFailure(userId, id, failure.reason, meta, typeForAudit);
      // The client may still be sending the body; don't keep the connection open for it.
      res.setHeader('Connection', 'close');
      throw failure ?? err;
    }
  });

  router.get(
    '/sessions/:id/documents',
    route({ params: sessionIdParamsSchema, response: documentListResponseSchema }, async (ctx) => ({
      documents: await docs.list(userIdOf(ctx.req), ctx.params.id),
    })),
  );

  router.post(
    '/sessions/:id/documents/submit',
    route({ params: sessionIdParamsSchema, response: kycSessionResponseSchema }, async (ctx) => ({
      session: await docs.submit(userIdOf(ctx.req), ctx.params.id, metaOf(ctx.req)),
    })),
  );

  router.delete(
    '/sessions/:id/documents/:docId',
    route({ params: sessionDocumentParamsSchema, response: okResponseSchema }, async (ctx) => {
      await docs.remove(userIdOf(ctx.req), ctx.params.id, ctx.params.docId, metaOf(ctx.req));
      return { ok: true as const };
    }),
  );

  router.get(
    '/documents/:docId/signed-url',
    route(
      {
        params: sessionDocumentParamsSchema.pick({ docId: true }),
        query: signedUrlQuerySchema,
        response: signedUrlResponseSchema,
      },
      (ctx) =>
        docs.issueSignedUrl(
          userIdOf(ctx.req),
          ctx.params.docId,
          ctx.query.purpose,
          metaOf(ctx.req),
        ),
    ),
  );

  return router;
}

/**
 * Who is asking for a file? People present their session cookie. The AI service has no cookie: it
 * presents the short-lived bearer token the worker minted for the seeded service account.
 */
async function authenticateViewer(req: Request, purpose: string, env: Env) {
  if (purpose === 'AI_INTERNAL') {
    const bearer = req.get('authorization')?.replace(/^Bearer\s+/i, '');
    const claims = bearer ? await verifyToken(bearer, env.JWT_SECRET) : null;
    if (claims && claims.role !== 'AI_SERVICE') throw forbidden();
    return claims;
  }
  const realm = purpose === 'OFFICER_REVIEW' ? 'officer' : 'customer';
  const cookie: unknown = req.cookies?.[cookieName(realm)];
  return typeof cookie === 'string' ? verifyToken(cookie, env.JWT_SECRET) : null;
}

/**
 * GET /files/:token, the decryption proxy. The token is a bearer credential AND the caller must
 * authenticate as the user it was issued to: a session cookie for people, a short-lived service
 * token for the AI service. A leaked URL is useless to anyone else.
 */
export function createFilesRouter(deps: { docs: DocumentsService; env: Env }): Router {
  const { docs, env } = deps;
  const router = Router();

  router.get('/:token', async (req, res) => {
    const params = fileTokenParamsSchema.safeParse(req.params);
    if (!params.success) throw new AppError(404, 'NOT_FOUND', 'Not found');
    const { issue, doc } = await docs.resolveToken(params.data.token);

    // Who is asking? People present their session cookie. The AI service has no cookie: it presents the
    // short-lived bearer token the worker minted for the seeded service account.
    const claims = await authenticateViewer(req, issue.purpose, env);
    if (!claims) throw unauthorized();
    if (claims.userId !== issue.issuedToUserId) throw forbidden();

    const { bytes, mimeType } = await docs.readDocument(issue, doc, claims.userId, metaOf(req));

    res.status(200);
    res.setHeader('Content-Type', mimeType);
    res.setHeader('Content-Length', String(bytes.length));
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Disposition', 'inline');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // Active content in an uploaded file must not be able to run or load anything.
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    // The web app (another origin) embeds these in <img>; the token + cookie are the protection.
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.end(bytes); // no ETag / range handling
  });

  return router;
}

export { toDocumentDto };
