import { Readable } from 'node:stream';
import {
  AUDIT_ACTIONS,
  AUDIT_EXPORT_URL_TTL_SECONDS,
  maskPan,
  type ExportStatusResponse,
  type Role,
} from '@kyc-setu/shared';
import { decryptToBuffer, type KmsClient } from '@kyc-setu/shared/crypto';
import { decryptPii } from '@kyc-setu/shared/pii';
import { AppError } from '../../lib/errors.js';
import type { AuditEntry } from '../auth/store.js';
import type { DocumentsService } from '../documents/documents.service.js';
import type { DocumentStore } from '../documents/store.js';
import { redactAadhaar } from '../extraction/pii.js';
import type { ExtractionStore } from '../extraction/store.js';
import { decryptStored } from '../kyc/personal-codec.js';
import type { KycStore, SessionRecord } from '../kyc/store.js';
import { referenceIdOf } from '../officer/customer-status.js';
import type { OfficerStore } from '../officer/store.js';
import { maskForRole } from '../pii/mask.js';
import { toAssessmentDto } from '../risk/risk.service.js';
import type { RiskStore } from '../risk/store.js';
import { CHAIN_ALGORITHM, istDay } from './chain.js';
import type { AuditChainStore } from './chain.store.js';
import { sha256Hex as consentHash } from '../consent/consent.service.js';
import type { ExportBucket } from './export.bucket.js';
import type { AuditExportStore, ExportRecord } from './export.store.js';
import { buildPacket, type PacketContent } from './packet.js';
import type { ExportSigner } from './signing.js';
import { loggerFor } from '../../observability/logger.js';

const log = loggerFor('export');

/** Puts a job on the audit queue. */
export interface AuditEnqueuer {
  enqueueExport(exportId: string): Promise<void>;
}

/** Everything the packet export needs that is not already in the service graph. */
export interface ExportDeps {
  store: AuditExportStore;
  bucket: ExportBucket;
  enqueuer: AuditEnqueuer;
  signer: ExportSigner;
}

export interface ExportServiceDeps {
  exports: ExportDeps;
  kycStore: KycStore;
  documentStore: DocumentStore;
  docs: DocumentsService;
  extractionStore: ExtractionStore;
  riskStore: RiskStore;
  officerStore: OfficerStore;
  chainStore: AuditChainStore;
  kms: KmsClient;
  piiKey: Buffer;
  includeDevInjected: boolean;
  now?: () => Date;
}

export interface Requester {
  userId: string;
  role: Role;
}

const EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'application/pdf': 'pdf',
};
const PAN_IN_TEXT = /\b[A-Z]{5}\d{4}[A-Z]\b/g;

/** What a packet does to raw OCR text before it leaves: Aadhaar digits and PAN numbers are masked to their last characters. */
export function redactRawText(text: string): string {
  return redactAadhaar(text).replace(PAN_IN_TEXT, (m) => maskPan(m) ?? 'XXXXXXXXXX');
}

export function createExportService(deps: ExportServiceDeps) {
  const {
    exports: x,
    kycStore,
    documentStore,
    docs,
    extractionStore,
    riskStore,
    officerStore,
    chainStore,
  } = deps;
  const now = deps.now ?? (() => new Date());

  const audit = (
    actor: string | null,
    action: string,
    sessionId: string,
    metadata: AuditEntry['metadata'],
  ): AuditEntry => ({
    actorId: actor,
    actorType: actor ? 'USER' : 'SYSTEM',
    action,
    entityType: 'KycSession',
    entityId: sessionId,
    metadata,
  });

  async function loadSession(id: string): Promise<SessionRecord> {
    const s = await kycStore.findSession(id);
    if (!s) throw new AppError(404, 'SESSION_NOT_FOUND', 'KYC session not found');
    return s;
  }

  /** Reads everything about one session and shapes it into the packet's content. */
  async function gather(
    exp: ExportRecord,
    requester: { id: string; role: Role },
  ): Promise<PacketContent> {
    const session = await loadSession(exp.sessionId);
    const [activeDocs, extractions, assessments, bio, decisions, auditRows, consent] =
      await Promise.all([
        documentStore.listActive(session.id),
        extractionStore.listForSession(session.id),
        riskStore.listAssessments(session.id),
        riskStore.latestBiometrics(session.id, { includeDevInjected: deps.includeDevInjected }),
        officerStore.decisionsFor(session.id),
        officerStore.sessionAudit(session.id),
        session.consentVersionId ? kycStore.findConsentById(session.consentVersionId) : null,
      ]);

    const documents: PacketContent['documents'] = [];
    for (const d of activeDocs) {
      documents.push({
        path: `documents/${d.type}.${EXT[d.mimeType] ?? 'bin'}`,
        bytes: new Uint8Array(await docs.decryptForExport(d)),
      });
    }

    const extractionJson = [];
    for (const e of extractions) {
      let rawText: string | null = null;
      if (e.rawTextEncrypted && e.encryptedDataKey && e.iv && e.authTag && e.kmsKeyId) {
        const plain = await decryptToBuffer(
          Readable.from([e.rawTextEncrypted]),
          { wrappedKey: e.encryptedDataKey, iv: e.iv, authTag: e.authTag, kmsKeyId: e.kmsKeyId },
          deps.kms,
        );
        rawText = redactRawText(plain.toString('utf8'));
      }
      const fields = structuredClone((e.fields ?? {}) as Record<string, { value?: string }>);
      const pan = fields['panNumber'];
      if (pan?.value?.startsWith('enc:')) {
        // Stored field-encrypted; a packet carries it masked like everything else about identifiers.
        pan.value = maskPan(decryptPii(pan.value, deps.piiKey)) ?? '';
      }
      extractionJson.push({
        documentId: e.documentId,
        documentType: e.documentType,
        status: e.status,
        completedAt: e.completedAt?.toISOString() ?? null,
        fields,
        qualityMetrics: e.qualityMetrics,
        modelVersions: e.modelVersions,
        aadhaarNumberLast4: e.aadhaarNumberLast4,
        rawText,
      });
    }

    const plain = decryptStored(session.personalDetails, deps.piiKey);
    const timeline = auditRows
      .filter((r) => r.action === 'kyc.session.transitioned' && r.entityType === 'KycSession')
      .map((r) => {
        const m = r.metadata as { from?: string; to?: string };
        return { at: r.createdAt.toISOString(), from: m.from ?? '', to: m.to ?? '' };
      });
    const checkpoints = await chainStore.checkpointsBetween(
      istDay(session.createdAt),
      istDay(now()),
    );
    const latest = assessments.at(-1) ?? null;

    return {
      manifest: {
        schemaVersion: 1,
        exportId: exp.id,
        generatedAt: now().toISOString(),
        generatedBy: { userId: requester.id, role: requester.role },
        session: {
          id: session.id,
          referenceId: referenceIdOf(session.id),
          status: session.status,
          createdAt: session.createdAt.toISOString(),
          submittedAt: session.submittedAt?.toISOString() ?? null,
          resubmitCount: decisions.filter((d) => d.decision === 'REQUEST_RESUBMIT').length,
          statusTimeline: timeline,
        },
        consent: consent
          ? {
              versionId: consent.id,
              version: consent.version,
              acceptedAt: session.consentAcceptedAt?.toISOString() ?? null,
              effectiveFrom: consent.effectiveFrom.toISOString(),
              supersededAt: consent.supersededAt?.toISOString() ?? null,
              sha256: consentHash(consent.bodyMarkdown),
              bodyMarkdown: consent.bodyMarkdown,
            }
          : null,
        riskEngine: {
          version: latest?.engineVersion ?? null,
          latestAssessmentId: latest?.id ?? null,
          assessmentCount: assessments.length,
        },
        auditChain: {
          algorithm: CHAIN_ALGORITHM,
          checkpoints: checkpoints.map((c) => ({
            chainDate: c.chainDate,
            startRowId: c.startRowId,
            endRowId: c.endRowId,
            rowCount: c.rowCount,
            previousCheckpointHash: c.previousCheckpointHash,
            chainHash: c.chainHash,
          })),
        },
        face: {
          available: false,
          reason:
            'Selfie capture, aligned crops and liveness frames are not stored yet (Phase 4 is not built)',
          signals: bio
            ? {
                faceMatchScore: bio.faceMatchScore,
                livenessPassed: bio.livenessPassed,
                source: bio.source,
              }
            : null,
        },
        redactions: [
          'personal.json: PAN, mobile and Aadhaar are masked exactly as in the review page',
          'extractions.json: Aadhaar digits and PAN numbers in the raw OCR text are masked to their last characters',
          'documents/: the uploaded files, decrypted and unchanged (they show what the customer uploaded)',
        ],
      },
      // Masked for the role that asked: an auditor never receives a full identifier through this route.
      personal: maskForRole(plain, requester.role),
      extractions: extractionJson,
      risk: assessments.map((a) => ({ ...toAssessmentDto(a), inputsSnapshot: a.inputsSnapshot })),
      decisions: decisions.map((d) => ({
        ...d,
        createdAt: d.createdAt.toISOString(),
      })),
      auditJsonl: auditRows
        .map((r) =>
          JSON.stringify({
            id: r.id,
            createdAt: r.createdAt.toISOString(),
            actorId: r.actorId,
            actorType: r.actorType,
            action: r.action,
            entityType: r.entityType,
            entityId: r.entityId,
            metadata: r.metadata,
          }),
        )
        .join('\n')
        .concat(auditRows.length ? '\n' : ''),
      faceSignals: bio
        ? {
            faceMatchScore: bio.faceMatchScore,
            faceMatchModel: bio.faceMatchModel,
            livenessPassed: bio.livenessPassed,
            source: bio.source,
          }
        : { available: false },
      documents,
    };
  }

  const toStatus = async (e: ExportRecord): Promise<ExportStatusResponse> => {
    let downloadUrl: string | null = null;
    let downloadExpiresAt: string | null = null;
    if (e.status === 'READY' && e.objectKey) {
      downloadUrl = await x.bucket.signedGetUrl(e.objectKey, AUDIT_EXPORT_URL_TTL_SECONDS);
      downloadExpiresAt = new Date(
        now().getTime() + AUDIT_EXPORT_URL_TTL_SECONDS * 1000,
      ).toISOString();
    }
    return {
      exportId: e.id,
      sessionId: e.sessionId,
      status: e.status,
      createdAt: e.createdAt.toISOString(),
      completedAt: e.completedAt?.toISOString() ?? null,
      sha256: e.sha256,
      bytes: e.bytes,
      downloadUrl,
      downloadExpiresAt,
      error: e.error,
    };
  };

  return {
    /** POST /audit/sessions/:id/export: records the request (and audits it) and queues the build. */
    async request(
      actor: Requester,
      sessionId: string,
    ): Promise<{ exportId: string; status: 'QUEUED' }> {
      const session = await loadSession(sessionId);
      const exp = await x.store.create(
        { sessionId: session.id, requestedById: actor.userId },
        (e) =>
          audit(actor.userId, AUDIT_ACTIONS.AUDIT_EXPORT_REQUESTED, session.id, {
            exportId: e.id,
            role: actor.role,
          }),
      );
      try {
        await x.enqueuer.enqueueExport(exp.id);
      } catch (err) {
        await x.store.markFailed(exp.id, 'The export could not be queued', now(), (e) =>
          audit(null, AUDIT_ACTIONS.AUDIT_EXPORT_FAILED, session.id, {
            exportId: e.id,
            reason: 'ENQUEUE_FAILED',
          }),
        );
        log.error({ err }, 'could not queue an export');
        throw new AppError(
          503,
          'EXPORT_UNAVAILABLE',
          'The export could not be queued. Try again shortly.',
        );
      }
      return { exportId: exp.id, status: 'QUEUED' };
    },

    /** The queue job: builds, signs and stores the packet. Safe to run again after a failure. */
    async process(exportId: string): Promise<{ status: 'READY' | 'SKIPPED'; sha256?: string }> {
      const exp = await x.store.find(exportId);
      if (!exp || exp.status === 'READY') return { status: 'SKIPPED' };
      await x.store.markRunning(exp.id, now());
      try {
        const requester = (await officerStore.findUsers([exp.requestedById]))[0];
        if (!requester) throw new Error('requester no longer exists');
        const content = await gather(exp, { id: requester.id, role: requester.role });
        const built = buildPacket(content, x.signer);
        const objectKey = `exports/${exp.sessionId}/${exp.id}.zip`;
        await x.bucket.put(objectKey, built.zip, 'application/zip');
        await x.store.markReady(
          exp.id,
          { objectKey, sha256: built.sha256, bytes: built.zip.length, at: now() },
          (e) =>
            audit(null, AUDIT_ACTIONS.AUDIT_EXPORT_COMPLETED, exp.sessionId, {
              exportId: e.id,
              requestedBy: exp.requestedById,
              // The ZIP's final hash and the key that signed it: what a later copy is compared with.
              sha256: built.sha256,
              bytes: built.zip.length,
              fileCount: Object.keys(built.files).length,
              signingKeyFingerprint: x.signer.fingerprint,
              documentCount: content.documents.length,
            }),
        );
        return { status: 'READY', sha256: built.sha256 };
      } catch (err) {
        const message = (err as Error).message ?? 'unknown error';
        await x.store.markFailed(exp.id, message, now(), (e) =>
          audit(null, AUDIT_ACTIONS.AUDIT_EXPORT_FAILED, exp.sessionId, {
            exportId: e.id,
            error: message.slice(0, 200),
          }),
        );
        throw err; // BullMQ retries; the next attempt starts from FAILED again
      }
    },

    /** GET /audit/exports/:id: status, and a one-hour link once it is ready. Each link issued is audited. */
    async status(actor: Requester, exportId: string): Promise<ExportStatusResponse> {
      const exp = await x.store.find(exportId);
      if (!exp) throw new AppError(404, 'EXPORT_NOT_FOUND', 'Export not found');
      const out = await toStatus(exp);
      if (out.downloadUrl) {
        await x.store.writeAudit(
          audit(actor.userId, AUDIT_ACTIONS.AUDIT_EXPORT_LINK_ISSUED, exp.sessionId, {
            exportId: exp.id,
            expiresInSeconds: AUDIT_EXPORT_URL_TTL_SECONDS,
          }),
        );
      }
      return out;
    },
  };
}
export type ExportService = ReturnType<typeof createExportService>;
