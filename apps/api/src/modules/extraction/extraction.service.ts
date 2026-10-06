import {
  AI_SERVICE_EMAIL,
  AUDIT_ACTIONS,
  EXTRACTION_FINISHED_STATUSES,
  EXTRACTION_FLAG_BY_STATUS,
  applyTransition,
  type DocumentType,
  type ExtractResponse,
  type ExtractionStatus,
  type ExtractionSummaryDto,
} from '@kyc-setu/shared';
import { encryptBuffer, decryptToBuffer, type KmsClient } from '@kyc-setu/shared/crypto';
import { decryptPii, encryptPii } from '@kyc-setu/shared/pii';
import { Readable } from 'node:stream';
import type { Env } from '../../config/env.js';
import { AppError, forbidden } from '../../lib/errors.js';
import { signToken } from '../../lib/jwt.js';
import type { AuditEntry, AuthStore } from '../auth/store.js';
import type { DocumentsService } from '../documents/documents.service.js';
import type { DocumentStore } from '../documents/store.js';
import { patchFrom, toState, type KycService } from '../kyc/kyc.service.js';
import type { KycStore } from '../kyc/store.js';
import { AiServiceError, type AiClient } from './ai-client.js';
import { last4FromMasked, panBlindIndex, redactAadhaar } from './pii.js';
import type { CompleteInput, ExtractionRecord, ExtractionStore } from './store.js';

/** What the queue must do after one run of the processor. */
export type ProcessOutcome =
  | { kind: 'done'; status: ExtractionStatus }
  | { kind: 'skipped'; reason: string }
  | { kind: 'retry'; error: Error }
  | { kind: 'failed'; error: Error };

/** Verification queue's view of job state. `attempt` is 1-based. */
export interface AttemptInfo {
  attempt: number;
  maxAttempts: number;
}

const STATUS_FROM_AI: Record<ExtractResponse['status'], CompleteInput['status']> = {
  ok: 'OK',
  low_quality: 'LOW_QUALITY',
  parse_failed: 'PARSE_FAILED',
  wrong_document: 'WRONG_DOCUMENT',
};

export interface ExtractionServiceDeps {
  env: Env;
  store: ExtractionStore;
  documents: DocumentsService;
  documentStore: DocumentStore;
  kycStore: KycStore;
  kyc: KycService;
  auth: Pick<AuthStore, 'findUserByEmail'>;
  ai: AiClient;
  kms: KmsClient;
  piiKey: Buffer;
  now?: () => Date;
}

const systemAudit = (
  action: string,
  entityType: 'Document' | 'KycSession',
  entityId: string,
  metadata: AuditEntry['metadata'],
  actorId: string | null = null,
): AuditEntry => ({
  actorId,
  actorType: actorId ? 'AI' : 'SYSTEM',
  action,
  entityType,
  entityId,
  metadata,
});

export function createExtractionService(deps: ExtractionServiceDeps) {
  const { env, store, documents, documentStore, kycStore, kyc, ai, kms, piiKey } = deps;
  const now = deps.now ?? (() => new Date());

  let serviceUserId: string | undefined;
  async function getServiceUserId(): Promise<string> {
    if (!serviceUserId) {
      const user = await deps.auth.findUserByEmail(AI_SERVICE_EMAIL);
      if (!user || user.role !== 'AI_SERVICE') {
        throw new AppError(
          500,
          'SERVICE_ACCOUNT_MISSING',
          'The AI service account is not seeded (run `pnpm seed`)',
        );
      }
      serviceUserId = user.id;
    }
    return serviceUserId;
  }

  /** Builds what we persist: sensitive values encrypted, raw text enveloped, indexed helpers derived. */
  async function toCompleteInput(result: ExtractResponse, attempt: number): Promise<CompleteInput> {
    const fields: Record<string, unknown> = { ...result.fields };
    let panNumberHmac: string | null = null;
    if (result.fields.panNumber) {
      const pan = result.fields.panNumber;
      panNumberHmac = panBlindIndex(pan.value, piiKey);
      fields['panNumber'] = { ...pan, value: encryptPii(pan.value, piiKey) }; // PAN is never stored in the clear
    }
    const masked = result.fields.aadhaarNumber?.value;
    let raw: CompleteInput['raw'] = null;
    if (result.rawText) {
      // The raw text contains the full Aadhaar number, so it only ever exists encrypted.
      const enc = await encryptBuffer(Buffer.from(result.rawText, 'utf8'), kms);
      raw = {
        ciphertext: enc.ciphertext,
        wrappedKey: enc.meta.wrappedKey,
        iv: enc.meta.iv,
        authTag: enc.meta.authTag,
        kmsKeyId: enc.meta.kmsKeyId,
      };
    }
    return {
      status: STATUS_FROM_AI[result.status],
      fields,
      qualityMetrics: result.quality,
      modelVersions: result.modelVersions,
      timings: result.timings,
      raw,
      panNumberHmac,
      aadhaarNumberLast4: masked ? last4FromMasked(masked) : null,
      attempt,
    };
  }

  /**
   * When every active document has a finished extraction, move DOCS_UPLOADED -> DOCS_EXTRACTED and
   * flag anything an officer should look at. An ERROR (our infrastructure failed) holds the session back.
   */
  async function maybeAdvanceSession(sessionId: string): Promise<void> {
    const session = await kycStore.findSession(sessionId);
    if (!session || session.status !== 'DOCS_UPLOADED') return;
    const rows = await store.listForSession(sessionId);
    const active = await documentStore.listActive(sessionId);
    const byDoc = new Map(rows.map((r) => [r.documentId, r.status]));
    const statuses = active.map((d) => byDoc.get(d.id));
    const finished: readonly (ExtractionStatus | undefined)[] = EXTRACTION_FINISHED_STATUSES;
    if (statuses.some((s) => !finished.includes(s))) return; // something still pending, or errored

    const flags = new Set(session.flags);
    for (const s of statuses) {
      const flag = s
        ? EXTRACTION_FLAG_BY_STATUS[s as keyof typeof EXTRACTION_FLAG_BY_STATUS]
        : undefined;
      if (flag) flags.add(flag);
    }
    const { session: next, audit } = applyTransition(
      toState(session),
      'DOCS_EXTRACTED',
      null,
      now(),
    );
    const added = [...flags].filter((f) => !session.flags.includes(f));
    await kycStore.updateSession(
      session.id,
      'DOCS_UPLOADED',
      { ...patchFrom(next), flags: [...flags] },
      [
        audit,
        ...added.map((flag) =>
          systemAudit(AUDIT_ACTIONS.EXTRACTION_SESSION_FLAGGED, 'KycSession', session.id, { flag }),
        ),
      ],
    );
  }

  async function flagSession(sessionId: string, flag: string): Promise<void> {
    const session = await kycStore.findSession(sessionId);
    if (!session || session.flags.includes(flag)) return;
    await kycStore.updateSession(session.id, session.status, { flags: [...session.flags, flag] }, [
      systemAudit(AUDIT_ACTIONS.EXTRACTION_SESSION_FLAGGED, 'KycSession', session.id, { flag }),
    ]);
  }

  return {
    /** One attempt at extracting one document. Never throws for expected failures: returns the outcome. */
    async process(documentId: string, info: AttemptInfo): Promise<ProcessOutcome> {
      const extraction = await store.findByDocumentId(documentId);
      if (!extraction) return { kind: 'skipped', reason: 'no extraction row' };
      if (extraction.status !== 'PENDING')
        return { kind: 'skipped', reason: `already ${extraction.status}` };
      const doc = await documentStore.findById(documentId);
      if (!doc) return { kind: 'skipped', reason: 'document not found' };
      if (doc.type === 'SIGNATURE') return { kind: 'skipped', reason: 'nothing to extract' };

      try {
        const serviceId = await getServiceUserId();
        const link = await documents.issueInternalUrl(serviceId, doc.id);
        const serviceToken = await signToken(
          { userId: serviceId, role: 'AI_SERVICE' },
          { secret: env.JWT_SECRET, expiresInSeconds: 60 },
        );
        const result = await ai.extract({
          type: doc.type as Exclude<DocumentType, 'SIGNATURE'>,
          documentId: doc.id,
          sessionId: doc.sessionId,
          signedUrl: link.url,
          serviceToken,
        });

        const input = await toCompleteInput(result, info.attempt);
        const saved = await store.complete(
          doc.id,
          input,
          systemAudit(
            AUDIT_ACTIONS.EXTRACTION_COMPLETED,
            'Document',
            doc.id,
            {
              documentId: doc.id,
              type: doc.type,
              status: input.status,
              attempt: info.attempt,
              // Field NAMES only: values are PII and live in the encrypted/derived columns.
              fieldsFound: Object.keys(result.fields).sort(),
              warnings: result.quality.warnings.map((w) => w.split(' ')[0] ?? w),
              totalMs: result.timings.totalMs,
            },
            serviceId,
          ),
        );
        if (!saved) return { kind: 'skipped', reason: 'already completed by another run' };
        await maybeAdvanceSession(doc.sessionId);
        return { kind: 'done', status: input.status };
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        const retryable =
          err instanceof AiServiceError ? err.retryable : !(err instanceof AppError);
        // Only a short, PII-free description is stored: never response bodies or document content.
        const message = `${error.name}: ${error.message}`.slice(0, 300);
        const isFinal = !retryable || info.attempt >= info.maxAttempts;
        if (!isFinal) {
          await store.recordAttemptFailure(
            doc.id,
            info.attempt,
            message,
            systemAudit(AUDIT_ACTIONS.EXTRACTION_ATTEMPT_FAILED, 'Document', doc.id, {
              documentId: doc.id,
              attempt: info.attempt,
              maxAttempts: info.maxAttempts,
              error: message,
            }),
          );
          return { kind: 'retry', error };
        }
        await store.fail(
          doc.id,
          info.attempt,
          message,
          systemAudit(AUDIT_ACTIONS.EXTRACTION_FAILED, 'Document', doc.id, {
            documentId: doc.id,
            attempt: info.attempt,
            error: message,
            retryable,
          }),
        );
        console.error(
          `[verification] extraction FAILED for document ${doc.id} after ${info.attempt} attempt(s): ${message}`,
        );
        await flagSession(doc.sessionId, EXTRACTION_FLAG_BY_STATUS.ERROR);
        return { kind: 'failed', error };
      }
    },

    /** Customer-facing: status and completion time only, never extracted values. */
    async summaryForSession(userId: string, sessionId: string): Promise<ExtractionSummaryDto[]> {
      const session = await kyc.loadOwned(userId, sessionId);
      return (await store.listForSession(session.id)).map(toSummary);
    },

    async summaryForDocument(userId: string, docId: string): Promise<ExtractionSummaryDto> {
      // 403 for "not yours" and "doesn't exist" alike, so ids can't be probed.
      const doc = await documentStore.findById(docId);
      const owner = doc ? (await kycStore.findSession(doc.sessionId))?.userId : undefined;
      if (!doc || owner !== userId) throw forbidden();
      const row = await store.findByDocumentId(docId);
      if (!row)
        throw new AppError(404, 'EXTRACTION_NOT_FOUND', 'No extraction for this document yet');
      return toSummary({ ...row, documentType: doc.type });
    },

    /** DEV ONLY (route is not registered in production). Everything stored, with Aadhaar redacted. */
    async debugView(documentId: string) {
      const row = await store.findByDocumentId(documentId);
      const doc = await documentStore.findById(documentId);
      if (!row || !doc)
        throw new AppError(404, 'EXTRACTION_NOT_FOUND', 'No extraction for this document');
      const fields = structuredClone((row.fields ?? {}) as Record<string, { value?: string }>);
      if (fields['panNumber']?.value?.startsWith('enc:')) {
        fields['panNumber'] = {
          ...fields['panNumber'],
          value: decryptPii(fields['panNumber'].value, piiKey),
        };
      }
      let rawText: string | null = null;
      if (row.rawTextEncrypted && row.encryptedDataKey && row.iv && row.authTag && row.kmsKeyId) {
        const plain = await decryptToBuffer(
          Readable.from([row.rawTextEncrypted]),
          {
            wrappedKey: row.encryptedDataKey,
            iv: row.iv,
            authTag: row.authTag,
            kmsKeyId: row.kmsKeyId,
          },
          kms,
        );
        rawText = redactAadhaar(plain.toString('utf8')); // the API never returns a full Aadhaar number
      }
      return {
        documentId,
        type: doc.type,
        status: row.status,
        attempt: row.attempt,
        errorMessage: row.errorMessage,
        completedAt: row.completedAt?.toISOString() ?? null,
        panNumberHmac: row.panNumberHmac,
        aadhaarNumberLast4: row.aadhaarNumberLast4,
        fields,
        qualityMetrics: row.qualityMetrics,
        modelVersions: row.modelVersions,
        timings: row.timings,
        rawText,
      };
    },
  };
}

function toSummary(row: ExtractionRecord & { documentType: DocumentType }): ExtractionSummaryDto {
  return {
    documentId: row.documentId,
    type: row.documentType,
    status: row.status,
    completedAt: row.completedAt?.toISOString() ?? null,
  };
}

export type ExtractionService = ReturnType<typeof createExtractionService>;
