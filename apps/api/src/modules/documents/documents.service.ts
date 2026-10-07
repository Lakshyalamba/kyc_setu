import { createHash, randomUUID } from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { fileTypeFromBuffer } from 'file-type';
import {
  ALLOWED_DOCUMENT_MIME,
  AUDIT_ACTIONS,
  DOCUMENT_TYPES,
  MAX_DOCUMENT_BYTES,
  AI_INTERNAL_LINK_TTL_SECONDS,
  SIGNED_URL_TTL_SECONDS,
  applyTransition,
  type DocumentDto,
  type DocumentType,
  type DocumentUploadResponse,
  type KycStatus,
  type SignedUrlPurpose,
  type SignedUrlRef,
  type SignedUrlResponse,
  type UPLOAD_FAILURE_REASONS,
} from '@kyc-setu/shared';
import { decryptToBuffer, encryptStream, type KmsClient } from '@kyc-setu/shared/crypto';
import type { Env } from '../../config/env.js';
import { AppError, forbidden } from '../../lib/errors.js';
import type { AuditEntry } from '../auth/store.js';
import type { KycService, RequestMeta } from '../kyc/kyc.service.js';
import { patchFrom, toState } from '../kyc/kyc.service.js';
import type { KycStore, SessionRecord } from '../kyc/store.js';
import type { VerificationEnqueuer } from '../../queue/verification.js';
import type { ObjectStore } from './object-store.js';
import {
  createFileToken,
  parseFileToken,
  verifyFileToken,
  type ParsedToken,
} from './signed-token.js';
import type { DocumentRecord, DocumentStore, SignedUrlIssueRecord } from './store.js';

export type UploadFailureReason = (typeof UPLOAD_FAILURE_REASONS)[number];

/** An upload that was rejected; carries the reason that is written to the audit log. */
export class UploadFailure extends AppError {
  constructor(
    status: number,
    code: string,
    message: string,
    public readonly reason: UploadFailureReason,
  ) {
    super(status, code, message);
    this.name = 'UploadFailure';
  }
}

/** Documents may only change before they are submitted (or when an officer asks for resubmission). */
const MUTABLE_STATUSES: KycStatus[] = ['PERSONAL_SUBMITTED', 'RESUBMIT_REQUESTED'];
const SNIFF_BYTES = 4100;

export interface DocumentsServiceDeps {
  env: Env;
  kyc: KycService;
  kycStore: KycStore;
  store: DocumentStore;
  objects: ObjectStore;
  kms: KmsClient;
  /** Queues extraction jobs after a successful documents submit. */
  enqueuer: VerificationEnqueuer;
  /**
   * Runs once a submit has committed. A resubmission that changed only documents with nothing to read (a signature)
   * queues no extraction that could move the session on, so the pipeline is nudged here.
   */
  afterSubmit?: (sessionId: string) => Promise<void>;
  now?: () => Date;
  newId?: () => string;
}

export const toDocumentDto = (d: DocumentRecord): DocumentDto => ({
  id: d.id,
  type: d.type,
  mimeType: d.mimeType,
  sizeBytes: d.sizeBytes,
  sha256: d.sha256,
  uploadedAt: d.uploadedAt.toISOString(),
});

/** Reads up to `n` bytes without losing them: returns the head plus a stream that replays everything. */
async function peek(stream: Readable, n: number): Promise<{ head: Buffer; rest: Readable }> {
  const it = stream[Symbol.asyncIterator]();
  const chunks: Buffer[] = [];
  let length = 0;
  let done = false;
  while (length < n) {
    const r = await it.next();
    if (r.done) {
      done = true;
      break;
    }
    const chunk = r.value as Buffer;
    chunks.push(chunk);
    length += chunk.length;
  }
  const head = Buffer.concat(chunks);
  async function* replay() {
    yield head;
    while (!done) {
      const r = await it.next();
      if (r.done) return;
      yield r.value as Buffer;
    }
  }
  return { head, rest: Readable.from(replay()) };
}

export function createDocumentsService(deps: DocumentsServiceDeps) {
  const { env, kyc, kycStore, store, objects, kms, enqueuer } = deps;
  const now = deps.now ?? (() => new Date());
  const newId = deps.newId ?? randomUUID;

  const audit = (
    userId: string,
    action: string,
    entityType: 'Document' | 'KycSession',
    entityId: string,
    metadata: AuditEntry['metadata'] = {},
  ): AuditEntry => ({ actorId: userId, actorType: 'USER', action, entityType, entityId, metadata });

  const requestMeta = (m: RequestMeta) => ({ ip: m.ip, userAgent: m.userAgent });

  function requireMutable(s: SessionRecord): void {
    if (!MUTABLE_STATUSES.includes(s.status)) {
      throw new AppError(
        409,
        'INVALID_STATE',
        `Documents can't be changed while the session is ${s.status}`,
      );
    }
  }

  /** After an officer asks for a resubmission only the requested slots may change; the rest stay as verified. */
  function requireSlotOpen(s: SessionRecord, type: DocumentType): void {
    if (s.status === 'RESUBMIT_REQUESTED' && !s.resubmitTypes.includes(type)) {
      throw new AppError(
        409,
        'RESUBMIT_SLOT_LOCKED',
        'This document was not requested again, so it can’t be changed',
      );
    }
  }

  return {
    /** Authorisation + state checks. Runs BEFORE any of the request body is read. */
    async prepareUpload(userId: string, sessionId: string): Promise<SessionRecord> {
      const s = await kyc.loadOwned(userId, sessionId);
      requireMutable(s);
      return s;
    },

    async recordFailure(
      userId: string,
      sessionId: string,
      reason: UploadFailureReason,
      m: RequestMeta,
      type?: string,
    ): Promise<void> {
      // Reason enum only. Never file contents, names or client-supplied strings beyond the enum.
      await store.writeAudit(
        audit(userId, AUDIT_ACTIONS.DOCUMENT_UPLOAD_FAILED, 'KycSession', sessionId, {
          reason,
          ...(type && (DOCUMENT_TYPES as readonly string[]).includes(type) ? { type } : {}),
          ...requestMeta(m),
        }),
      );
    },

    /**
     * Sniffs, hashes, encrypts and stores one file, then records it. Throws `UploadFailure` for
     * anything the caller did wrong. Bytes never touch disk and are bounded by MAX_DOCUMENT_BYTES.
     */
    async upload(
      userId: string,
      session: SessionRecord,
      input: { type: DocumentType; declaredMime: string; file: Readable },
      m: RequestMeta,
    ): Promise<DocumentUploadResponse> {
      requireSlotOpen(session, input.type);
      const documentId = newId();
      const storageKey = `sessions/${session.id}/${documentId}.enc`;
      let failure: UploadFailure | undefined;
      let stored = false;

      try {
        const { head, rest } = await peek(input.file, SNIFF_BYTES);
        if (head.length === 0) {
          throw new UploadFailure(400, 'EMPTY_FILE', 'The uploaded file is empty', 'MISSING_FILE');
        }
        // Trust the bytes, not the client-declared type.
        const sniffed = await fileTypeFromBuffer(head);
        const allowed: readonly string[] = ALLOWED_DOCUMENT_MIME[input.type];
        if (!sniffed || !allowed.includes(sniffed.mime)) {
          throw new UploadFailure(
            415,
            'UNSUPPORTED_MEDIA_TYPE',
            `This file type isn't allowed for ${input.type}. Allowed: ${allowed.join(', ')}`,
            'UNSUPPORTED_TYPE',
          );
        }
        if (input.declaredMime !== sniffed.mime) {
          throw new UploadFailure(
            415,
            'MIME_MISMATCH',
            'The file does not match its declared type',
            'MIME_MISMATCH',
          );
        }

        const hash = createHash('sha256');
        let sizeBytes = 0;
        const meter = new Transform({
          transform(chunk: Buffer, _enc, cb) {
            sizeBytes += chunk.length;
            if (sizeBytes > MAX_DOCUMENT_BYTES) {
              failure = new UploadFailure(
                413,
                'FILE_TOO_LARGE',
                'Files can be at most 5 MB',
                'TOO_LARGE',
              );
              return cb(failure);
            }
            hash.update(chunk);
            cb(null, chunk);
          },
        });
        rest.once('error', (err) => meter.destroy(err));
        rest.pipe(meter);

        const { ciphertext, meta: envelopePromise } = await encryptStream(meter, kms);
        await objects.put(storageKey, ciphertext, 'application/octet-stream');
        stored = true;
        const envelope = await envelopePromise;
        const sha256 = hash.digest('hex');

        const inserted = await store.insertReplacing(
          {
            id: documentId,
            sessionId: session.id,
            type: input.type,
            storageKey,
            mimeType: sniffed.mime,
            sizeBytes,
            sha256,
            encryptedDataKey: envelope.wrappedKey,
            kmsKeyId: envelope.kmsKeyId,
            iv: envelope.iv,
            authTag: envelope.authTag,
          },
          (replaced) => [
            audit(userId, AUDIT_ACTIONS.DOCUMENT_UPLOADED, 'Document', documentId, {
              documentId,
              sessionId: session.id,
              type: input.type,
              sha256,
              sizeBytes,
              mime: sniffed.mime,
              ...requestMeta(m),
            }),
            ...(replaced
              ? [
                  audit(userId, AUDIT_ACTIONS.DOCUMENT_REPLACED, 'Document', documentId, {
                    oldDocumentId: replaced.id,
                    newDocumentId: documentId,
                    type: input.type,
                  }),
                ]
              : []),
          ],
        );
        if (!inserted) {
          throw new AppError(
            409,
            'CONFLICT',
            'Another upload for this document is in progress. Please retry.',
          );
        }
        stored = false; // committed: the object is now referenced
        return {
          documentId,
          type: input.type,
          sha256,
          uploadedAt: inserted.document.uploadedAt.toISOString(),
        };
      } catch (err) {
        if (stored) await objects.remove(storageKey).catch(() => undefined); // don't leave orphans
        if (failure) throw failure;
        if (err instanceof AppError) throw err;
        console.error('[documents] upload failed', (err as Error).message);
        throw new UploadFailure(
          502,
          'STORAGE_ERROR',
          'Could not store the file. Please try again.',
          'STORAGE_ERROR',
        );
      }
    },

    async list(userId: string, sessionId: string): Promise<DocumentDto[]> {
      await kyc.loadOwned(userId, sessionId);
      return (await store.listActive(sessionId)).map(toDocumentDto);
    },

    async remove(userId: string, sessionId: string, docId: string, m: RequestMeta): Promise<void> {
      const s = await kyc.loadOwned(userId, sessionId);
      requireMutable(s);
      const doc = await store.findById(docId);
      if (!doc || doc.sessionId !== s.id || doc.replacedById !== null) {
        throw new AppError(404, 'DOCUMENT_NOT_FOUND', 'Document not found');
      }
      requireSlotOpen(s, doc.type);
      // Soft delete: the row and the ciphertext are kept.
      const ok = await store.softDelete(
        docId,
        audit(userId, AUDIT_ACTIONS.DOCUMENT_DELETED, 'Document', docId, {
          documentId: docId,
          sessionId: s.id,
          type: doc.type,
          ...requestMeta(m),
        }),
      );
      if (!ok) throw new AppError(404, 'DOCUMENT_NOT_FOUND', 'Document not found');
    },

    /** POST /kyc/sessions/:id/documents/submit */
    async submit(userId: string, sessionId: string, m: RequestMeta) {
      const s = await kyc.loadOwned(userId, sessionId);
      requireMutable(s);
      const active = await store.listActive(s.id);
      const documentTypes = active.map((d) => d.type);
      const missing = DOCUMENT_TYPES.filter((t) => !documentTypes.includes(t));
      if (missing.length > 0) {
        throw new AppError(409, 'DOCUMENTS_INCOMPLETE', 'Upload all required documents first', {
          missing,
        });
      }
      const { session: next, audit: transition } = applyTransition(
        { ...toState(s), documentTypes },
        'DOCS_UPLOADED',
        userId,
        now(),
      );
      // One extraction row per document, created in the SAME transaction as the state change, so a
      // submitted session can never exist without its extraction work. A signature has nothing to read.
      const extractions = active.map((d) => ({
        documentId: d.id,
        status: d.type === 'SIGNATURE' ? ('SKIPPED' as const) : ('PENDING' as const),
      }));
      const toQueue = active.filter((d) => d.type !== 'SIGNATURE');
      const updated = await kycStore.updateSession(
        s.id,
        s.status,
        // The slots opened by a resubmission request close again once the customer submits.
        { ...patchFrom(next), resubmitTypes: [] },
        [
          transition,
          audit(userId, AUDIT_ACTIONS.KYC_DOCUMENTS_SUBMITTED, 'KycSession', s.id, {
            documentCount: documentTypes.length,
            ...requestMeta(m),
          }),
          ...toQueue.map((d) =>
            audit(userId, AUDIT_ACTIONS.EXTRACTION_JOB_ENQUEUED, 'Document', d.id, {
              documentId: d.id,
              sessionId: s.id,
              type: d.type,
            }),
          ),
        ],
        undefined,
        extractions,
      );
      if (!updated)
        throw new AppError(
          409,
          'CONFLICT',
          'The session changed while processing your request. Please retry.',
        );
      try {
        await enqueuer.enqueueExtractions(toQueue.map((d) => d.id));
      } catch (err) {
        // The rows are committed as PENDING; the worker's recovery sweep re-queues them.
        console.error(
          '[documents] could not enqueue extraction jobs; the recovery sweep will retry',
          (err as Error).message,
        );
      }
      try {
        await deps.afterSubmit?.(s.id);
      } catch (err) {
        console.error('[documents] post-submit step failed', (err as Error).message);
      }
      return kyc.toDto(updated);
    },

    /**
     * A 60-second link for the AI service to read one document. Only the verification worker calls
     * this, for the seeded service account: there is no HTTP route that issues AI_INTERNAL links.
     */
    async issueInternalUrl(
      serviceUserId: string,
      docId: string,
    ): Promise<{ url: string; expiresAt: Date }> {
      const doc = await store.findById(docId);
      if (!doc) throw new AppError(404, 'DOCUMENT_NOT_FOUND', 'Document not found');
      const expiresAt = new Date(now().getTime() + AI_INTERNAL_LINK_TTL_SECONDS * 1000);
      const issue = await store.createSignedUrlIssue(
        { documentId: doc.id, issuedToUserId: serviceUserId, purpose: 'AI_INTERNAL', expiresAt },
        (i) => ({
          ...audit(serviceUserId, AUDIT_ACTIONS.DOCUMENT_SIGNED_URL_ISSUED, 'Document', doc.id, {
            documentId: doc.id,
            issueId: i.id,
            purpose: 'AI_INTERNAL',
            expiresAt: expiresAt.toISOString(),
            issuedTo: serviceUserId,
          }),
          actorType: 'AI',
        }),
      );
      const token = createFileToken(
        {
          issueId: issue.id,
          documentId: doc.id,
          purpose: 'AI_INTERNAL',
          issuedToUserId: serviceUserId,
          expiresAtMs: expiresAt.getTime(),
        },
        env.FILE_URL_SECRET,
      );
      return { url: `${env.API_PUBLIC_URL}/files/${token}`, expiresAt };
    },

    /**
     * An officer's 5-minute link to one document. Role checks happen at the route; every link is its own
     * SignedUrlIssue row and its own audit row, because the trail of who was shown what is the point.
     */
    async issueOfficerUrl(
      officerId: string,
      doc: DocumentRecord,
      m: RequestMeta,
    ): Promise<SignedUrlRef> {
      const expiresAt = new Date(now().getTime() + SIGNED_URL_TTL_SECONDS * 1000);
      const issue = await store.createSignedUrlIssue(
        { documentId: doc.id, issuedToUserId: officerId, purpose: 'OFFICER_REVIEW', expiresAt },
        (i) =>
          audit(officerId, AUDIT_ACTIONS.DOCUMENT_SIGNED_URL_ISSUED, 'Document', doc.id, {
            documentId: doc.id,
            sessionId: doc.sessionId,
            issueId: i.id,
            purpose: 'OFFICER_REVIEW',
            expiresAt: expiresAt.toISOString(),
            issuedTo: officerId,
            ...requestMeta(m),
          }),
      );
      const token = createFileToken(
        {
          issueId: issue.id,
          documentId: doc.id,
          purpose: 'OFFICER_REVIEW',
          issuedToUserId: officerId,
          expiresAtMs: expiresAt.getTime(),
        },
        env.FILE_URL_SECRET,
      );
      return {
        url: `${env.API_PUBLIC_URL}/files/${token}`,
        expiresAt: expiresAt.toISOString(),
        purpose: 'OFFICER_REVIEW',
      };
    },

    /** GET /kyc/documents/:docId/signed-url */
    async issueSignedUrl(
      userId: string,
      docId: string,
      purpose: SignedUrlPurpose,
      m: RequestMeta,
    ): Promise<SignedUrlResponse> {
      // 403 for "not yours" and for "doesn't exist" alike, so ids can't be probed.
      const doc = await store.findById(docId);
      const owner = doc ? (await kycStore.findSession(doc.sessionId))?.userId : undefined;
      if (!doc || owner !== userId) throw forbidden();
      // Customers may only ever preview; OFFICER_REVIEW is for the (future) officer realm.
      if (purpose !== 'CUSTOMER_PREVIEW') throw forbidden();
      if (doc.replacedById !== null)
        throw new AppError(404, 'DOCUMENT_NOT_FOUND', 'Document not found');

      const expiresAt = new Date(now().getTime() + SIGNED_URL_TTL_SECONDS * 1000);
      const issue = await store.createSignedUrlIssue(
        { documentId: doc.id, issuedToUserId: userId, purpose, expiresAt },
        (i) =>
          audit(userId, AUDIT_ACTIONS.DOCUMENT_SIGNED_URL_ISSUED, 'Document', doc.id, {
            documentId: doc.id,
            issueId: i.id,
            purpose,
            expiresAt: expiresAt.toISOString(),
            issuedTo: userId,
            ...requestMeta(m),
          }),
      );
      const token = createFileToken(
        {
          issueId: issue.id,
          documentId: doc.id,
          purpose,
          issuedToUserId: userId,
          expiresAtMs: expiresAt.getTime(),
        },
        env.FILE_URL_SECRET,
      );
      return {
        url: `${env.API_PUBLIC_URL}/files/${token}`,
        expiresAt: expiresAt.toISOString(),
        purpose,
      };
    },

    /**
     * Step 1 of the proxy: structure, expiry, and the MAC recomputed from the stored issue row.
     * Every failure other than expiry looks identical (404) so tokens can't be probed.
     */
    async resolveToken(
      token: string,
    ): Promise<{ issue: SignedUrlIssueRecord; doc: DocumentRecord; parsed: ParsedToken }> {
      const notFound = () => new AppError(404, 'NOT_FOUND', 'Not found');
      const parsed = parseFileToken(token);
      if (!parsed) throw notFound();
      if (parsed.expiresAtMs <= now().getTime()) {
        throw new AppError(410, 'LINK_EXPIRED', 'This link has expired');
      }
      const issue = await store.findIssue(parsed.issueId);
      if (!issue) throw notFound();
      const doc = await store.findById(issue.documentId);
      if (!doc) throw notFound();
      const valid = verifyFileToken(
        parsed,
        {
          issueId: issue.id,
          documentId: issue.documentId,
          purpose: issue.purpose,
          issuedToUserId: issue.issuedToUserId,
          expiresAtMs: issue.expiresAt.getTime(),
        },
        env.FILE_URL_SECRET,
      );
      if (!valid) throw notFound();
      return { issue, doc, parsed };
    },

    /**
     * Step 2 of the proxy. Decrypts fully and verifies the GCM tag and the stored SHA-256 BEFORE a
     * single byte is released, and writes the `document.viewed` audit row before returning bytes.
     */
    async readDocument(
      issue: SignedUrlIssueRecord,
      doc: DocumentRecord,
      viewerUserId: string,
      m: RequestMeta,
    ): Promise<{ bytes: Buffer; mimeType: string }> {
      if (issue.purpose === 'CUSTOMER_PREVIEW' && doc.replacedById !== null) {
        throw new AppError(404, 'NOT_FOUND', 'Not found');
      }
      let bytes: Buffer;
      try {
        bytes = await decryptToBuffer(
          await objects.get(doc.storageKey),
          {
            wrappedKey: doc.encryptedDataKey,
            iv: doc.iv,
            authTag: doc.authTag,
            kmsKeyId: doc.kmsKeyId,
          },
          kms,
        );
        if (createHash('sha256').update(bytes).digest('hex') !== doc.sha256) {
          throw new Error('stored hash mismatch');
        }
      } catch (err) {
        console.error('[documents] integrity failure', doc.id, (err as Error).message);
        await store.writeAudit(
          audit(viewerUserId, 'document.integrity_failed', 'Document', doc.id, {
            documentId: doc.id,
          }),
        );
        throw new AppError(500, 'DOCUMENT_INTEGRITY_ERROR', 'This document could not be read');
      }
      await store.writeAudit({
        ...audit(viewerUserId, AUDIT_ACTIONS.DOCUMENT_VIEWED, 'Document', doc.id, {
          documentId: doc.id,
          viewerUserId,
          bytesStreamed: bytes.length,
          issueId: issue.id,
          purpose: issue.purpose,
          ...requestMeta(m),
        }),
        actorType: issue.purpose === 'AI_INTERNAL' ? 'AI' : 'USER',
      });
      return { bytes, mimeType: doc.mimeType };
    },
  };
}
export type DocumentsService = ReturnType<typeof createDocumentsService>;
