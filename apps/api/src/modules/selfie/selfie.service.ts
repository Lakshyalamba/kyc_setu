import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { fileTypeFromBuffer } from 'file-type';
import {
  AI_INTERNAL_LINK_TTL_SECONDS,
  AI_SERVICE_EMAIL,
  AUDIT_ACTIONS,
  FACE_MATCH_THRESHOLDS,
  MAX_DOCUMENT_BYTES,
  MAX_SELFIE_FRAME_BYTES,
  MAX_SELFIE_RETAKES,
  SELFIE_FRAME_COUNT,
  SIGNED_URL_TTL_SECONDS,
  applyTransition,
  decideFaceMatch,
  type FaceMatchDecisionValue,
  type LivenessMethodValue,
  type SelfieDeviceMeta,
  type SelfieStatusResponse,
  type SelfieUploadResponse,
  type SignedUrlPurpose,
} from '@kyc-setu/shared';
import {
  decryptToBuffer,
  encryptBuffer,
  type EnvelopeMeta,
  type KmsClient,
} from '@kyc-setu/shared/crypto';
import { encryptPii } from '@kyc-setu/shared/pii';
import type { Env } from '../../config/env.js';
import { AppError } from '../../lib/errors.js';
import { signToken } from '../../lib/jwt.js';
import { annotateContext } from '../../observability/context.js';
import { loggerFor } from '../../observability/logger.js';
import type { AuditEntry, AuthStore } from '../auth/store.js';
import type { DocumentsService } from '../documents/documents.service.js';
import type { ObjectStore } from '../documents/object-store.js';
import type { DocumentStore, SignedUrlIssueRecord } from '../documents/store.js';
import type { AiClient } from '../extraction/ai-client.js';
import { AiServiceError } from '../extraction/ai-client.js';
import { patchFrom, toState, type RequestMeta } from '../kyc/kyc.service.js';
import type { KycStore, SessionRecord } from '../kyc/store.js';
import type { VerificationEnqueuer } from '../../queue/verification.js';
import type { CaptureRecord, SelfieStore, StoredEnvelope } from './store.js';

const log = loggerFor('selfie');

/** What a stored selfie object is, as `selfie:<captureId>:<slot>`. */
export type SelfieSlot = 'frame:0' | 'frame:1' | 'frame:2' | 'best' | 'crop:id' | 'crop:selfie';
const SLOTS: readonly SelfieSlot[] = [
  'frame:0',
  'frame:1',
  'frame:2',
  'best',
  'crop:id',
  'crop:selfie',
];
export const objectRefOf = (captureId: string, slot: SelfieSlot) => `selfie:${captureId}:${slot}`;
const parseObjectRef = (ref: string): { captureId: string; slot: SelfieSlot } | null => {
  const m = /^selfie:([0-9a-f-]{36}):(.+)$/.exec(ref);
  const slot = m?.[2] as SelfieSlot | undefined;
  return m && slot && SLOTS.includes(slot) ? { captureId: m[1]!, slot } : null;
};

const envelopeOf = (m: EnvelopeMeta): StoredEnvelope => ({
  wrappedKey: m.wrappedKey.toString('base64'),
  iv: m.iv.toString('base64'),
  authTag: m.authTag.toString('base64'),
  kmsKeyId: m.kmsKeyId,
});
const metaOf = (e: StoredEnvelope): EnvelopeMeta => ({
  wrappedKey: Buffer.from(e.wrappedKey, 'base64'),
  iv: Buffer.from(e.iv, 'base64'),
  authTag: Buffer.from(e.authTag, 'base64'),
  kmsKeyId: e.kmsKeyId,
});

const ACCEPTED_IMAGES = new Set(['image/jpeg', 'image/png']);

export interface SelfieServiceDeps {
  env: Env;
  store: SelfieStore;
  kycStore: KycStore;
  documentStore: DocumentStore;
  documents: DocumentsService;
  objects: ObjectStore;
  kms: KmsClient;
  piiKey: Buffer;
  enqueuer: VerificationEnqueuer;
  ai: AiClient;
  auth: Pick<AuthStore, 'findUserByEmail'>;
  /** Told when a check finishes, so the risk assessment can be queued once everything is in. */
  onChecksChanged: (sessionId: string) => Promise<unknown>;
  now?: () => Date;
}

/** What the customer sends: three frames and the best one, or one picture (the file-upload fallback). */
export type SelfieUpload =
  | { method: 'MOTION_CHECK'; frames: Buffer[]; best: Buffer; deviceMeta: SelfieDeviceMeta }
  | { method: 'NONE'; image: Buffer; deviceMeta: SelfieDeviceMeta };

export function createSelfieService(deps: SelfieServiceDeps) {
  const { env, store, kycStore, documentStore, documents, objects, kms, piiKey, ai } = deps;
  const now = deps.now ?? (() => new Date());

  const audit = (
    actorId: string | null,
    action: string,
    sessionId: string,
    metadata: AuditEntry['metadata'],
  ): AuditEntry => ({
    actorId,
    actorType: actorId ? 'USER' : 'SYSTEM',
    action,
    entityType: 'KycSession',
    entityId: sessionId,
    metadata,
  });

  async function loadOwned(userId: string, sessionId: string): Promise<SessionRecord> {
    const session = await kycStore.findSession(sessionId);
    if (!session || session.userId !== userId)
      throw new AppError(404, 'SESSION_NOT_FOUND', 'KYC session not found');
    return session;
  }

  let serviceUserId: string | undefined;
  async function getServiceUserId(): Promise<string> {
    if (!serviceUserId) {
      const user = await deps.auth.findUserByEmail(AI_SERVICE_EMAIL);
      if (!user || user.role !== 'AI_SERVICE')
        throw new AppError(
          500,
          'SERVICE_ACCOUNT_MISSING',
          'The AI service account is not seeded (run `pnpm seed`)',
        );
      serviceUserId = user.id;
    }
    return serviceUserId;
  }

  async function put(sessionId: string, captureId: string, name: string, bytes: Buffer) {
    const enc = await encryptBuffer(bytes, kms);
    const key = `sessions/${sessionId}/selfie/${captureId}/${name}.enc`;
    await objects.put(key, Readable.from([enc.ciphertext]), 'application/octet-stream');
    return { key, envelope: envelopeOf(enc.meta) };
  }

  async function sniff(bytes: Buffer, limit: number): Promise<void> {
    if (bytes.length === 0) throw new AppError(400, 'EMPTY_FILE', 'A picture is empty');
    if (bytes.length > limit) throw new AppError(413, 'FILE_TOO_LARGE', 'A picture is too large');
    const type = await fileTypeFromBuffer(bytes);
    if (!type || !ACCEPTED_IMAGES.has(type.mime))
      throw new AppError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Send JPEG or PNG pictures only');
  }

  /** What the customer's checks look like now. Used by the status route, retake rules and the risk service's readiness. */
  async function checksOf(sessionId: string) {
    const capture = await store.activeCapture(sessionId);
    if (!capture) return null;
    const [liveness, face, captures] = await Promise.all([
      store.livenessFor(capture.id),
      store.faceMatchFor(capture.id),
      store.capturesOf(sessionId),
    ]);
    const retakesUsed = captures.length - 1;
    const livenessDone = capture.livenessMethod === 'NONE' || liveness !== null;
    const done = livenessDone && face !== null;
    const livenessBad = liveness !== null && liveness.result !== 'PASSED';
    const faceBad = face?.decision === 'AUTO_FAIL';
    // A failed check with a retake still available is the customer's call: retake, or go on.
    const awaitingCustomer =
      done &&
      (livenessBad || faceBad) &&
      retakesUsed < MAX_SELFIE_RETAKES &&
      capture.confirmedAt === null;
    return {
      capture,
      liveness,
      face,
      retakesUsed,
      livenessDone,
      done,
      awaitingCustomer,
      livenessBad,
      faceBad,
    };
  }

  async function issueLink(
    captureId: string,
    slot: SelfieSlot,
    to: string,
    purpose: SignedUrlPurpose,
    ttlSeconds: number,
    sessionId: string,
  ) {
    return documents.issueObjectUrl({
      objectRef: objectRefOf(captureId, slot),
      issuedToUserId: to,
      purpose,
      ttlSeconds,
      audit: (issue) => ({
        ...audit(to, AUDIT_ACTIONS.SELFIE_LINK_ISSUED, sessionId, {
          captureId,
          slot,
          issueId: issue.id,
          purpose,
          expiresAt: new Date(now().getTime() + ttlSeconds * 1000).toISOString(),
        }),
        actorType: purpose === 'AI_INTERNAL' ? 'AI' : 'USER',
      }),
    });
  }

  const serviceToken = (userId: string) =>
    signToken({ userId, role: 'AI_SERVICE' }, { secret: env.JWT_SECRET, expiresInSeconds: 60 });

  return {
    checksOf,

    /**
     * The first selfie (status DOCS_EXTRACTED) or a retake (SELFIE_CAPTURED, while a retake is allowed). Validates the
     * pictures by their bytes, encrypts each as its own envelope, records the capture, moves the session to
     * SELFIE_CAPTURED and queues the two checks. The pictures are never returned to the customer.
     */
    async upload(
      userId: string,
      sessionId: string,
      input: SelfieUpload,
      m: RequestMeta,
      mode: 'first' | 'retake' = 'first',
    ): Promise<SelfieUploadResponse> {
      const session = await loadOwned(userId, sessionId);
      annotateContext({ sessionId });
      const checks = await checksOf(sessionId);
      const firstTime = session.status === 'DOCS_EXTRACTED' && checks === null;
      if (mode === 'first' && checks !== null)
        throw new AppError(
          409,
          'SELFIE_EXISTS',
          'You have already taken a selfie. Use the retake option if you need to.',
        );
      if (mode === 'retake' && checks === null)
        throw new AppError(409, 'NO_SELFIE_TO_RETAKE', 'There is no selfie to retake yet.');
      if (!firstTime) {
        if (session.status !== 'SELFIE_CAPTURED' || !checks)
          throw new AppError(
            409,
            'SELFIE_NOT_ALLOWED',
            'A selfie can be taken once the documents have been read.',
          );
        if (checks.retakesUsed >= MAX_SELFIE_RETAKES)
          throw new AppError(
            409,
            'SELFIE_RETAKE_USED',
            'The one retake has been used. An officer can ask for another.',
          );
        const okToRetake = !checks.done || checks.livenessBad || checks.faceBad;
        if (!okToRetake)
          throw new AppError(
            409,
            'SELFIE_RETAKE_NOT_NEEDED',
            'Your selfie was accepted, so there is nothing to retake.',
          );
      }

      const idDoc = (await documentStore.listActive(sessionId)).find(
        (d) => d.type === 'AADHAAR_FRONT',
      );
      if (!idDoc)
        throw new AppError(
          409,
          'ID_DOCUMENT_MISSING',
          'The Aadhaar front is needed to compare your selfie.',
        );

      const pictures =
        input.method === 'MOTION_CHECK' ? [...input.frames, input.best] : [input.image];
      if (input.method === 'MOTION_CHECK') {
        if (input.frames.length !== SELFIE_FRAME_COUNT)
          throw new AppError(
            400,
            'WRONG_FRAME_COUNT',
            `Send exactly ${SELFIE_FRAME_COUNT} frames and the best one.`,
          );
        // The best frame is the middle one, by position: nothing here lets a client pick a flattering frame.
        if (!input.best.equals(input.frames[1]!))
          throw new AppError(
            400,
            'BEST_FRAME_MISMATCH',
            'The best frame must be the middle frame.',
          );
      }
      for (const bytes of pictures)
        await sniff(bytes, input.method === 'NONE' ? MAX_DOCUMENT_BYTES : MAX_SELFIE_FRAME_BYTES);

      const captureId = randomUUID();
      const stored: { key: string; envelope: StoredEnvelope }[] = [];
      try {
        for (let i = 0; i < pictures.length; i++) {
          stored.push(
            await put(
              sessionId,
              captureId,
              i === pictures.length - 1 && input.method === 'MOTION_CHECK' ? 'best' : `frame-${i}`,
              pictures[i]!,
            ),
          );
        }
      } catch (err) {
        await Promise.all(stored.map((s) => objects.remove(s.key).catch(() => undefined)));
        log.error({ err }, 'could not store the selfie');
        throw new AppError(502, 'STORAGE_ERROR', 'Could not store the pictures. Please try again.');
      }

      const method: LivenessMethodValue = input.method === 'NONE' ? 'NONE' : 'MOTION_CHECK';
      const frameStored = method === 'MOTION_CHECK' ? stored.slice(0, SELFIE_FRAME_COUNT) : stored;
      const bestStored = method === 'MOTION_CHECK' ? stored[SELFIE_FRAME_COUNT]! : stored[0]!;
      const audits = [
        audit(
          userId,
          firstTime ? AUDIT_ACTIONS.SELFIE_CAPTURED : AUDIT_ACTIONS.SELFIE_REPLACED,
          sessionId,
          {
            captureId,
            replaced: checks?.capture.id ?? null,
            livenessMethod: method,
          },
        ),
        ...(method === 'NONE'
          ? [
              audit(userId, AUDIT_ACTIONS.SELFIE_FALLBACK_USED, sessionId, {
                captureId,
                note: 'file upload: no motion check was possible',
              }),
            ]
          : []),
      ];
      const row = await store.insertCapture(
        {
          id: captureId,
          sessionId,
          framesStorageKeys: frameStored.map((s) => s.key),
          bestFrameKey: bestStored.key,
          frameEnvelopes: [
            ...frameStored.map((s) => s.envelope),
            ...(method === 'MOTION_CHECK' ? [bestStored.envelope] : []),
          ],
          livenessMethod: method,
          deviceMeta: { userAgent: input.deviceMeta.userAgent, screen: input.deviceMeta.screen },
        },
        checks?.capture.id ?? null,
        audits,
      );

      if (firstTime) {
        const { session: next, audit: entry } = applyTransition(
          toState(session),
          'SELFIE_CAPTURED',
          userId,
          now(),
        );
        const moved = await kycStore.updateSession(sessionId, 'DOCS_EXTRACTED', patchFrom(next), [
          entry,
        ]);
        if (!moved)
          throw new AppError(
            409,
            'SESSION_CHANGED',
            'The application changed while the selfie was uploading. Reload and try again.',
          );
      }
      try {
        await deps.enqueuer.enqueueSelfieChecks({
          captureId,
          idDocumentId: idDoc.id,
          motionCheck: method === 'MOTION_CHECK',
        });
      } catch (err) {
        // The capture is stored; a worker sweep or the next status read can re-queue. Say so rather than failing the upload.
        log.error({ err, captureId }, 'could not enqueue the selfie checks');
      }
      return {
        captureId: row.id,
        livenessMethod: row.livenessMethod,
        capturedAt: row.capturedAt.toISOString(),
      };
    },

    /** The customer's view: whether each check has finished, and the coarse outcome. Never a score, a metric or a picture. */
    async status(userId: string, sessionId: string): Promise<SelfieStatusResponse> {
      await loadOwned(userId, sessionId);
      const c = await checksOf(sessionId);
      if (!c) {
        return {
          captureId: null,
          livenessMethod: null,
          liveness: { status: 'PENDING', failureReason: null },
          faceMatch: { status: 'PENDING', decision: null },
          canRetake: false,
          retakesUsed: 0,
        };
      }
      const liveness =
        c.capture.livenessMethod === 'NONE'
          ? { status: 'NOT_PERFORMED' as const, failureReason: null }
          : c.liveness
            ? { status: c.liveness.result, failureReason: c.liveness.failureReason }
            : { status: 'PENDING' as const, failureReason: null };
      return {
        captureId: c.capture.id,
        livenessMethod: c.capture.livenessMethod,
        liveness,
        faceMatch: c.face
          ? { status: 'DONE', decision: c.face.decision }
          : { status: 'PENDING', decision: null },
        canRetake: c.awaitingCustomer,
        retakesUsed: c.retakesUsed,
      };
    },

    /** "Continue without retaking": the customer accepts a failed check as it is, and the risk assessment goes ahead. */
    async confirm(userId: string, sessionId: string, m: RequestMeta): Promise<void> {
      await loadOwned(userId, sessionId);
      const c = await checksOf(sessionId);
      if (!c || !c.done)
        throw new AppError(409, 'CHECKS_NOT_DONE', 'The checks have not finished yet.');
      const ok = await store.confirmCapture(
        c.capture.id,
        audit(userId, AUDIT_ACTIONS.SELFIE_CONFIRMED, sessionId, {
          captureId: c.capture.id,
          userAgent: m.userAgent,
        }),
      );
      if (!ok)
        throw new AppError(409, 'ALREADY_CONFIRMED', 'This selfie has already been confirmed.');
      await deps.onChecksChanged(sessionId);
    },

    /** The worker's motion check. Safe to run twice. */
    async runMotionCheck(
      captureId: string,
    ): Promise<{ kind: 'done' | 'skipped'; reason?: string }> {
      const capture = await store.findCapture(captureId);
      if (!capture) return { kind: 'skipped', reason: 'capture not found' };
      annotateContext({ sessionId: capture.sessionId });
      if (capture.replacedById) return { kind: 'skipped', reason: 'capture was replaced' };
      if (capture.livenessMethod === 'NONE')
        return { kind: 'skipped', reason: 'no motion check for the fallback' };
      if (await store.livenessFor(captureId)) return { kind: 'skipped', reason: 'already done' };

      const service = await getServiceUserId();
      const link = async (slot: SelfieSlot) =>
        (
          await issueLink(
            captureId,
            slot,
            service,
            'AI_INTERNAL',
            AI_INTERNAL_LINK_TTL_SECONDS,
            capture.sessionId,
          )
        ).url;
      const result = await ai.motionCheck(
        {
          captureId,
          frameUrls: [await link('frame:0'), await link('frame:1'), await link('frame:2')],
          bestFrameUrl: await link('best'),
        },
        await serviceToken(service),
      );
      await store.insertLiveness(
        {
          selfieCaptureId: captureId,
          method: 'MOTION_CHECK',
          result: result.result,
          failureReason: result.failureReason,
          metrics: result.metrics,
          modelVersion: result.modelVersion,
        },
        {
          ...audit(null, AUDIT_ACTIONS.MOTION_CHECK_COMPLETED, capture.sessionId, {
            captureId,
            result: result.result,
            failureReason: result.failureReason,
            meanSsim: result.metrics.meanSsim,
            modelVersion: result.modelVersion,
          }),
        },
      );
      await deps.onChecksChanged(capture.sessionId);
      return { kind: 'done' };
    },

    /** The worker's face match against the Aadhaar front it was queued for. Safe to run twice. */
    async runFaceMatch(
      captureId: string,
      idDocumentId: string,
    ): Promise<{ kind: 'done' | 'skipped'; reason?: string }> {
      const capture = await store.findCapture(captureId);
      if (!capture) return { kind: 'skipped', reason: 'capture not found' };
      annotateContext({ sessionId: capture.sessionId });
      if (capture.replacedById) return { kind: 'skipped', reason: 'capture was replaced' };
      if (await store.faceMatchFor(captureId, idDocumentId))
        return { kind: 'skipped', reason: 'already done' };
      const doc = await documentStore.findById(idDocumentId);
      if (!doc || doc.replacedById !== null)
        return { kind: 'skipped', reason: 'the Aadhaar front was replaced' };

      const service = await getServiceUserId();
      const selfie = await issueLink(
        captureId,
        'best',
        service,
        'AI_INTERNAL',
        AI_INTERNAL_LINK_TTL_SECONDS,
        capture.sessionId,
      );
      const idLink = await documents.issueInternalUrl(service, idDocumentId);
      const result = await ai.faceMatch(
        {
          selfieCaptureId: captureId,
          selfieBestUrl: selfie.url,
          idDocumentId,
          idDocumentUrl: idLink.url,
        },
        await serviceToken(service),
      );

      const thresholds = FACE_MATCH_THRESHOLDS;
      // Nothing to compare (no face on the ID, none in the selfie, or two) is a failed comparison, with its reason.
      const decision: FaceMatchDecisionValue = result.reason
        ? 'AUTO_FAIL'
        : decideFaceMatch(result.score, thresholds);

      let crops: {
        id: { key: string; envelope: StoredEnvelope };
        selfie: { key: string; envelope: StoredEnvelope };
      } | null = null;
      if (result.idFaceCropPng && result.selfieFaceCropPng) {
        crops = {
          id: await put(
            capture.sessionId,
            captureId,
            'crop-id',
            Buffer.from(result.idFaceCropPng, 'base64'),
          ),
          selfie: await put(
            capture.sessionId,
            captureId,
            'crop-selfie',
            Buffer.from(result.selfieFaceCropPng, 'base64'),
          ),
        };
      }
      // Embeddings are a biometric template: encrypted at rest like a PAN, never logged, never audited.
      const sealed = (b64: string | null) =>
        b64 ? Buffer.from(encryptPii(b64, piiKey), 'utf8') : null;
      const saved = await store.insertFaceMatch(
        {
          sessionId: capture.sessionId,
          selfieCaptureId: captureId,
          idDocumentId,
          score: result.score,
          threshold: thresholds.autoPass,
          failThreshold: thresholds.autoFail,
          decision,
          reason: result.reason,
          embeddingVersion: result.embeddingVersion,
          selfieEmbedding: sealed(result.selfieEmbedding),
          idEmbedding: sealed(result.idEmbedding),
          idFaceCropKey: crops?.id.key ?? null,
          selfieFaceCropKey: crops?.selfie.key ?? null,
          cropEnvelopes: crops
            ? { idCrop: crops.id.envelope, selfieCrop: crops.selfie.envelope }
            : null,
        },
        audit(null, AUDIT_ACTIONS.FACE_MATCH_COMPLETED, capture.sessionId, {
          captureId,
          decision,
          reason: result.reason,
          // A score is fine to record: it is a number about two faces, not a face. The embeddings are not.
          score: result.score,
          embeddingVersion: result.embeddingVersion,
        }),
      );
      if (!saved) {
        await Promise.all(
          [crops?.id.key, crops?.selfie.key]
            .filter(Boolean)
            .map((k) => objects.remove(k!).catch(() => undefined)),
        );
        return { kind: 'skipped', reason: 'already done' };
      }
      await deps.onChecksChanged(capture.sessionId);
      return { kind: 'done' };
    },

    /** A link an officer's browser can show: one of the frames, the best frame or an aligned crop. */
    async issueOfficerLink(
      officerId: string,
      captureId: string,
      slot: SelfieSlot,
      sessionId: string,
    ) {
      const link = await issueLink(
        captureId,
        slot,
        officerId,
        'OFFICER_REVIEW',
        SIGNED_URL_TTL_SECONDS,
        sessionId,
      );
      return {
        url: link.url,
        expiresAt: link.expiresAt.toISOString(),
        purpose: 'OFFICER_REVIEW' as const,
      };
    },

    /** Step 2 of the /files proxy for a selfie object: decrypt, verify the GCM tag, audit, release. */
    async readObject(
      issue: SignedUrlIssueRecord,
      viewerUserId: string,
      m: RequestMeta,
    ): Promise<{ bytes: Buffer; mimeType: string }> {
      const ref = issue.objectRef ? parseObjectRef(issue.objectRef) : null;
      if (!ref) throw new AppError(404, 'NOT_FOUND', 'Not found');
      const capture = await store.findCapture(ref.captureId);
      if (!capture) throw new AppError(404, 'NOT_FOUND', 'Not found');
      const located = await locate(capture, ref.slot);
      if (!located) throw new AppError(404, 'NOT_FOUND', 'Not found');
      let bytes: Buffer;
      try {
        bytes = await decryptToBuffer(
          await objects.get(located.key),
          metaOf(located.envelope),
          kms,
        );
      } catch (err) {
        log.error({ err, captureId: capture.id }, 'selfie object integrity failure');
        throw new AppError(500, 'SELFIE_INTEGRITY_ERROR', 'This picture could not be read');
      }
      await store.writeAudit({
        ...audit(viewerUserId, 'selfie.viewed', capture.sessionId, {
          captureId: capture.id,
          slot: ref.slot,
          issueId: issue.id,
          purpose: issue.purpose,
          bytesStreamed: bytes.length,
          userAgent: m.userAgent,
        }),
        actorType: issue.purpose === 'AI_INTERNAL' ? 'AI' : 'USER',
      });
      const type = await fileTypeFromBuffer(bytes);
      return { bytes, mimeType: type?.mime ?? 'application/octet-stream' };
    },
  };

  async function locate(
    capture: CaptureRecord,
    slot: SelfieSlot,
  ): Promise<{ key: string; envelope: StoredEnvelope } | null> {
    if (slot.startsWith('frame:')) {
      const i = Number(slot.slice(6));
      const key = capture.framesStorageKeys[i];
      const envelope = capture.frameEnvelopes[i];
      return key && envelope ? { key, envelope } : null;
    }
    if (slot === 'best') {
      const i = capture.framesStorageKeys.indexOf(capture.bestFrameKey);
      // For a motion check the best frame is stored under its own key (the 4th envelope); for the fallback it is frame 0.
      const envelope =
        i >= 0
          ? capture.frameEnvelopes[i]
          : capture.frameEnvelopes[capture.frameEnvelopes.length - 1];
      return envelope ? { key: capture.bestFrameKey, envelope } : null;
    }
    const match = await store.faceMatchFor(capture.id);
    if (!match?.cropEnvelopes) return null;
    return slot === 'crop:id'
      ? match.idFaceCropKey
        ? { key: match.idFaceCropKey, envelope: match.cropEnvelopes.idCrop }
        : null
      : match.selfieFaceCropKey
        ? { key: match.selfieFaceCropKey, envelope: match.cropEnvelopes.selfieCrop }
        : null;
  }
}
export type SelfieService = ReturnType<typeof createSelfieService>;
export { AiServiceError };
