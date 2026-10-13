import { defaultConfig, isoDateEqual, nameSimilarity } from '@kyc-setu/risk';
import {
  AUDIT_ACTIONS,
  MAX_RESUBMISSIONS,
  REASON_CODES_BY_DECISION,
  applyTransition,
  maskAadhaar,
  maskName,
  maskPan,
  qualitySchema,
  type AssignmentDto,
  type AuditSessionsQuery,
  type AuditSessionsResponse,
  type ComparisonRow,
  type DecisionBlocker,
  type DecisionRequest,
  type DecisionResponse,
  type DocumentType,
  type KycStatus,
  type QueueItem,
  type QueueQuery,
  type QueueResponse,
  type ReviewAuditEntry,
  type ReviewExtraction,
  type ReviewPayload,
  type RevealResponse,
  type Role,
} from '@kyc-setu/shared';
import { decryptPii } from '@kyc-setu/shared/pii';
import type { KmsClient } from '@kyc-setu/shared/crypto';
import type { Env } from '../../config/env.js';
import { AppError } from '../../lib/errors.js';
import type { VerificationEnqueuer } from '../../queue/verification.js';
import type { AuditEntry } from '../auth/store.js';
import type { DocumentsService } from '../documents/documents.service.js';
import type { DocumentStore } from '../documents/store.js';
import type { ExtractionStore, ExtractionWithType } from '../extraction/store.js';
import { patchFrom, toState, type RequestMeta } from '../kyc/kyc.service.js';
import { decryptStored } from '../kyc/personal-codec.js';
import { sha256Hex } from '../consent/consent.service.js';
import { referenceIdOf } from './customer-status.js';
import { istDayBounds } from '../audit/chain.js';
import { maskForRole } from '../pii/mask.js';
import type { KycStore, SessionRecord } from '../kyc/store.js';
import { buildRiskInput } from '../risk/inputs.js';
import { toAssessmentDto } from '../risk/risk.service.js';
import type { BiometricRecord, RiskStore } from '../risk/store.js';
import type {
  AssignmentRecord,
  AuditRow,
  Band,
  OfficerStore,
  QueueCursor,
  UserSummary,
} from './store.js';
import { loggerFor } from '../../observability/logger.js';

const log = loggerFor('officer');

export interface Actor {
  userId: string;
  role: Role;
}

export interface OfficerServiceDeps {
  env: Env;
  store: OfficerStore;
  kycStore: KycStore;
  documentStore: DocumentStore;
  extractionStore: ExtractionStore;
  riskStore: RiskStore;
  docs: DocumentsService;
  enqueuer: VerificationEnqueuer;
  kms: KmsClient;
  piiKey: Buffer;
  now?: () => Date;
}

const STAFF_ROLES: Role[] = ['OFFICER', 'OFFICER_LEAD', 'AUDITOR'];
const WRITER_ROLES: Role[] = ['OFFICER', 'OFFICER_LEAD'];
const NEXT_STATUS = {
  APPROVE: 'APPROVED',
  REJECT: 'REJECTED',
  REQUEST_RESUBMIT: 'RESUBMIT_REQUESTED',
} as const satisfies Record<DecisionRequest['decision'], KycStatus>;
/** Steps the customer goes through again after a resubmission request. */
const REDONE_STEPS = ['DOCUMENTS', 'SELFIE', 'REVIEW'] as const;
/** The first words of a consent text, without markdown headings, for a panel that should not show a page of legal text. */
export function snippetOf(markdown: string, max = 200): string {
  const plain = markdown
    .replace(/^#+\s*/gm, '')
    .replace(/[*_`>]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return plain.length <= max ? plain : `${plain.slice(0, max).replace(/\s+\S*$/, '')}…`;
}

const HIDDEN_METADATA_KEYS = new Set(['ip', 'userAgent']);
const RANK: Record<Band, number> = { HIGH: 3, MEDIUM: 2, LOW: 1 };

export const isWriter = (role: Role) => WRITER_ROLES.includes(role);

/**
 * Four-eyes: whoever created an application must not be the one to review it.
 *
 * TODO(four-eyes): officers cannot create customer sessions yet. When an admin flow can open a session on a
 * customer's behalf, store the creating officer on the session and refuse here when it equals `officerId`.
 * Until then the only violation that can occur is an officer reviewing a session that belongs to their own account.
 */
export function assertFourEyes(session: Pick<SessionRecord, 'userId'>, officerId: string): void {
  if (session.userId === officerId) {
    throw new AppError(403, 'FOUR_EYES', 'You cannot review an application you created');
  }
}

const encodeCursor = (c: QueueCursor) => Buffer.from(JSON.stringify(c)).toString('base64url');
function decodeCursor(raw: string): QueueCursor {
  try {
    const v = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as Partial<QueueCursor>;
    if (
      typeof v.rank === 'number' &&
      typeof v.at === 'string' &&
      !Number.isNaN(Date.parse(v.at)) &&
      typeof v.id === 'string' &&
      /^[0-9a-f-]{36}$/i.test(v.id)
    ) {
      return { rank: v.rank, at: v.at, id: v.id };
    }
  } catch {
    /* falls through */
  }
  throw new AppError(400, 'VALIDATION_ERROR', 'Invalid cursor');
}

function decodeAuditCursor(raw: string): { at: string; id: string } {
  try {
    const v = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as {
      at?: unknown;
      id?: unknown;
    };
    if (
      typeof v.at === 'string' &&
      !Number.isNaN(Date.parse(v.at)) &&
      typeof v.id === 'string' &&
      /^[0-9a-f-]{36}$/i.test(v.id)
    ) {
      return { at: v.at, id: v.id };
    }
  } catch {
    /* falls through */
  }
  throw new AppError(400, 'VALIDATION_ERROR', 'Invalid cursor');
}

type FieldJson = { value?: string; confidence?: number; bbox?: unknown } | undefined;
const asFields = (v: unknown): Record<string, FieldJson> =>
  v && typeof v === 'object' ? (v as Record<string, FieldJson>) : {};

export function createOfficerService(deps: OfficerServiceDeps) {
  const { env, store, kycStore, documentStore, extractionStore, riskStore, docs, piiKey } = deps;
  const now = deps.now ?? (() => new Date());
  const includeDevInjected = env.NODE_ENV !== 'production';

  const audit = (
    actor: Actor | null,
    action: string,
    sessionId: string,
    metadata: AuditEntry['metadata'],
  ): AuditEntry => ({
    actorId: actor?.userId ?? null,
    actorType: actor ? 'USER' : 'SYSTEM',
    action,
    entityType: 'KycSession',
    entityId: sessionId,
    metadata,
  });

  async function loadSession(sessionId: string): Promise<SessionRecord> {
    const s = await kycStore.findSession(sessionId);
    if (!s) throw new AppError(404, 'SESSION_NOT_FOUND', 'KYC session not found');
    return s;
  }

  const displayName = (u: Pick<UserSummary, 'email'> | undefined): string =>
    u?.email ?? 'Unknown officer';

  const toAssignmentDto = (a: AssignmentRecord, viewerId: string): AssignmentDto => ({
    officerId: a.officerId,
    officerName: a.officerEmail,
    assignedAt: a.assignedAt.toISOString(),
    isMine: a.officerId === viewerId,
  });

  function requireUnderReview(s: SessionRecord): void {
    if (s.status !== 'UNDER_REVIEW') {
      throw new AppError(
        409,
        'INVALID_STATE',
        `Only applications under review can be claimed or decided (this one is ${s.status})`,
      );
    }
  }

  const heldByOther = (a: AssignmentRecord) =>
    new AppError(409, 'ASSIGNED_TO_OTHER', `Being reviewed by ${a.officerEmail}`, {
      officerId: a.officerId,
      officerName: a.officerEmail,
      assignedAt: a.assignedAt.toISOString(),
    });

  // ---- the evidence, shared by the review page and the frozen decision snapshot -----------------------------

  /** Typed vs extracted, side by side, with the verdict for each row. Compares full values server-side, returns masked ones. */
  async function buildComparison(
    session: SessionRecord,
    extractions: ExtractionWithType[],
  ): Promise<ComparisonRow[]> {
    const typed = decryptStored(session.personalDetails, piiKey);
    const { input } = await buildRiskInput(
      { session, extractions, biometrics: null, findPriorCandidates: async () => [] },
      { piiKey, kms: deps.kms },
    );
    const byType = new Map(extractions.map((e) => [e.documentType, e]));
    const field = (type: DocumentType, key: string) => {
      const row = byType.get(type);
      const f = asFields(row?.fields)[key];
      return row && f?.value ? { documentId: row.documentId, value: f.value } : null;
    };
    const str = (v: unknown) => (typeof v === 'string' && v !== '' ? v : null);
    const min = defaultConfig.thresholds.nameSimilarityMin;
    const refs =
      (...fs: ({ documentId: string } | null)[]) =>
      (keys: string[]) =>
        fs.flatMap((f, i) =>
          f && keys[i] ? [{ documentId: f.documentId, fieldKey: keys[i] }] : [],
        );

    const nameOf = (
      label: string,
      typedValue: string | null,
      a: ReturnType<typeof field>,
      b: ReturnType<typeof field>,
      keyA: string,
      keyB: string,
      field_: 'fullName' | 'fatherName',
    ) => {
      const pairs: number[] = [];
      if (typedValue && a) pairs.push(nameSimilarity(typedValue, a.value));
      if (typedValue && b) pairs.push(nameSimilarity(typedValue, b.value));
      if (a && b) pairs.push(nameSimilarity(a.value, b.value));
      const similarity = pairs.length > 0 ? Math.min(...pairs) : null;
      const used = [a ? keyA : '', b ? keyB : ''];
      return {
        field: field_,
        label,
        typed: typedValue,
        fromPan: a?.value ?? null,
        fromAadhaar: b?.value ?? null,
        status: similarity === null ? 'UNAVAILABLE' : similarity >= min ? 'MATCH' : 'MISMATCH',
        similarity,
        refs: refs(a, b)(used),
      } satisfies ComparisonRow;
    };

    const panName = field('PAN', 'name');
    const aadhaarName = field('AADHAAR_FRONT', 'name');
    const panFather = field('PAN', 'fatherName');
    const panDob = field('PAN', 'dob');
    const aadhaarDob = field('AADHAAR_FRONT', 'dob');
    const typedDob = str(typed['dateOfBirth']);

    const dobPairs: boolean[] = [];
    if (typedDob && panDob) dobPairs.push(isoDateEqual(typedDob, panDob.value));
    if (typedDob && aadhaarDob) dobPairs.push(isoDateEqual(typedDob, aadhaarDob.value));
    if (panDob && aadhaarDob) dobPairs.push(isoDateEqual(panDob.value, aadhaarDob.value));

    const panRow = byType.get('PAN');
    const panExtracted = asFields(panRow?.fields)['panNumber']?.value;
    const extractedPan = panExtracted
      ? panExtracted.startsWith('enc:')
        ? decryptPii(panExtracted, piiKey)
        : panExtracted
      : null;
    const aadhaarFront = byType.get('AADHAAR_FRONT');
    const aadhaarMasked = asFields(aadhaarFront?.fields)['aadhaarNumber']?.value ?? null;
    const typedAadhaar = str(typed['aadhaarNumber']);
    const last4 = (v: string | null) => (v ? v.replace(/\D/g, '').slice(-4) : null);
    const aadhaarMatch =
      input.comparisons.aadhaarTypedMatchesExtracted ??
      (typedAadhaar && aadhaarMasked ? last4(typedAadhaar) === last4(aadhaarMasked) : null);
    const verdict = (m: boolean | null): ComparisonRow['status'] =>
      m === null ? 'UNAVAILABLE' : m ? 'MATCH' : 'MISMATCH';

    return [
      nameOf('Full name', str(typed['fullName']), panName, aadhaarName, 'name', 'name', 'fullName'),
      nameOf(
        "Father's name",
        str(typed['fatherName']),
        panFather,
        null,
        'fatherName',
        '',
        'fatherName',
      ),
      {
        field: 'dateOfBirth',
        label: 'Date of birth',
        typed: typedDob,
        fromPan: panDob?.value ?? null,
        fromAadhaar: aadhaarDob?.value ?? null,
        status:
          !panDob && !aadhaarDob ? 'UNAVAILABLE' : dobPairs.every(Boolean) ? 'MATCH' : 'MISMATCH',
        similarity: null,
        refs: refs(panDob, aadhaarDob)(['dob', 'dob']),
      },
      {
        field: 'pan',
        label: 'PAN',
        typed: maskPan(str(typed['panNumber'])),
        fromPan: maskPan(extractedPan),
        fromAadhaar: null,
        status: verdict(input.comparisons.panTypedMatchesExtracted),
        similarity: null,
        refs:
          panRow && panExtracted ? [{ documentId: panRow.documentId, fieldKey: 'panNumber' }] : [],
      },
      {
        field: 'aadhaar',
        label: 'Aadhaar',
        typed: typedAadhaar ? maskAadhaar(typedAadhaar) : null,
        fromPan: null,
        fromAadhaar: aadhaarMasked,
        status: verdict(aadhaarMatch),
        similarity: null,
        refs:
          aadhaarFront && aadhaarMasked
            ? [{ documentId: aadhaarFront.documentId, fieldKey: 'aadhaarNumber' }]
            : [],
      },
    ];
  }

  function toReviewExtraction(row: ExtractionWithType): ReviewExtraction {
    const fields = Object.entries(asFields(row.fields)).flatMap(([key, f]) => {
      if (!f || typeof f.value !== 'string') return [];
      const value =
        key === 'panNumber' && f.value.startsWith('enc:')
          ? (maskPan(decryptPii(f.value, piiKey)) ?? '')
          : f.value;
      const bbox = f.bbox as { x: number; y: number; w: number; h: number } | undefined;
      return [{ key, value, confidence: f.confidence ?? 0, bbox: bbox ?? null }];
    });
    const quality = qualitySchema.partial().safeParse(row.qualityMetrics);
    return {
      documentId: row.documentId,
      documentType: row.documentType,
      status: row.status,
      completedAt: row.completedAt?.toISOString() ?? null,
      fields,
      quality: quality.success ? quality.data : null,
      modelVersions:
        row.modelVersions && typeof row.modelVersions === 'object'
          ? (row.modelVersions as Record<string, unknown>)
          : null,
    };
  }

  function toFaceAndLiveness(bio: BiometricRecord | null) {
    const t = defaultConfig.thresholds;
    const faceMatch: ReviewPayload['faceMatch'] =
      bio && bio.faceMatchScore !== null
        ? {
            available: true,
            score: bio.faceMatchScore,
            thresholds: { fail: t.faceMatchMin, borderline: t.faceMatchBorderlineMax },
            modelVersion: bio.faceMatchModel,
            source: bio.source,
            // Aligned crops arrive with the selfie pipeline (Phase 4); nothing stores them yet.
            aadhaarCropUrl: null,
            selfieCropUrl: null,
          }
        : { available: false };
    const liveness: ReviewPayload['liveness'] =
      bio && bio.livenessPassed !== null
        ? {
            available: true,
            passed: bio.livenessPassed,
            failureReason: null,
            frameUrls: [],
          }
        : { available: false };
    return { faceMatch, liveness };
  }

  async function gather(session: SessionRecord) {
    const [activeDocs, extractions, assessment, bio] = await Promise.all([
      documentStore.listActive(session.id),
      extractionStore.listForSession(session.id),
      riskStore.latestAssessment(session.id),
      riskStore.latestBiometrics(session.id, { includeDevInjected }),
    ]);
    const comparison = await buildComparison(session, extractions);
    return {
      activeDocs,
      extractions,
      comparison,
      risk: assessment ? toAssessmentDto(assessment) : null,
      ...toFaceAndLiveness(bio),
    };
  }

  /** What the officer saw, frozen into the Decision. Sensitive values stay encrypted exactly as stored. */
  async function buildSnapshot(
    session: SessionRecord,
    assignment: AssignmentRecord,
    officerId: string,
  ): Promise<Record<string, unknown>> {
    const g = await gather(session);
    return {
      capturedAt: now().toISOString(),
      capturedBy: officerId,
      session: {
        id: session.id,
        status: session.status,
        createdAt: session.createdAt.toISOString(),
        submittedAt: session.submittedAt?.toISOString() ?? null,
        flags: session.flags,
        consentVersionId: session.consentVersionId,
        consentAcceptedAt: session.consentAcceptedAt?.toISOString() ?? null,
      },
      // Stored form: the PAN and Aadhaar inside are the same ciphertext the session row holds.
      personalDetails: session.personalDetails,
      documents: g.activeDocs.map((d) => ({
        id: d.id,
        type: d.type,
        sha256: d.sha256,
        mimeType: d.mimeType,
        sizeBytes: d.sizeBytes,
        uploadedAt: d.uploadedAt.toISOString(),
      })),
      extractions: g.extractions.map((e) => ({
        documentId: e.documentId,
        documentType: e.documentType,
        status: e.status,
        fields: e.fields, // PAN number stays field-encrypted
        qualityMetrics: e.qualityMetrics,
        modelVersions: e.modelVersions,
        aadhaarNumberLast4: e.aadhaarNumberLast4,
        completedAt: e.completedAt?.toISOString() ?? null,
      })),
      comparison: g.comparison,
      faceMatch: g.faceMatch,
      liveness: g.liveness,
      risk: g.risk,
      assignment: {
        officerId: assignment.officerId,
        assignedAt: assignment.assignedAt.toISOString(),
      },
    };
  }

  async function nameMap(ids: (string | null)[]): Promise<Map<string, UserSummary>> {
    const unique = [...new Set(ids.filter((i): i is string => !!i))];
    return new Map((await store.findUsers(unique)).map((u) => [u.id, u]));
  }

  function toAuditEntry(row: AuditRow, users: Map<string, UserSummary>): ReviewAuditEntry {
    const user = row.actorId ? users.get(row.actorId) : undefined;
    const kind: ReviewAuditEntry['actor']['kind'] =
      row.actorType === 'AI'
        ? 'AI'
        : !user
          ? row.actorType === 'SYSTEM'
            ? 'SYSTEM'
            : 'CUSTOMER'
          : STAFF_ROLES.includes(user.role)
            ? 'OFFICER'
            : user.role === 'AI_SERVICE'
              ? 'AI'
              : 'CUSTOMER';
    const metadata = Object.fromEntries(
      Object.entries((row.metadata ?? {}) as Record<string, unknown>).filter(
        ([k]) => !HIDDEN_METADATA_KEYS.has(k),
      ),
    );
    return {
      id: row.id,
      at: row.createdAt.toISOString(),
      action: row.action,
      actor: {
        id: row.actorId,
        displayName:
          kind === 'OFFICER'
            ? displayName(user)
            : kind === 'CUSTOMER'
              ? 'Customer'
              : kind === 'AI'
                ? 'AI service'
                : 'System',
        kind,
      },
      entityType: row.entityType,
      metadata,
    };
  }

  function blockersFor(
    actor: Actor,
    session: SessionRecord,
    assignment: AssignmentRecord | null,
  ): DecisionBlocker[] {
    const out: DecisionBlocker[] = [];
    if (!isWriter(actor.role)) out.push('READ_ONLY_ROLE');
    if (session.status !== 'UNDER_REVIEW') out.push('NOT_UNDER_REVIEW');
    if (session.userId === actor.userId) out.push('FOUR_EYES');
    if (!assignment) out.push('NOT_CLAIMED');
    else if (assignment.officerId !== actor.userId) out.push('LOCKED_BY_OTHER');
    return out;
  }

  return {
    // ---- queue ----------------------------------------------------------------------------------------------

    async queue(actor: Actor, q: QueueQuery): Promise<QueueResponse> {
      const assignedTo: Parameters<OfficerStore['queue']>[0]['assignedTo'] =
        q.assignedTo === 'me'
          ? { kind: 'officer', officerId: actor.userId }
          : q.assignedTo === 'unassigned'
            ? { kind: 'unassigned' }
            : q.assignedTo
              ? { kind: 'officer', officerId: q.assignedTo }
              : undefined;
      const rows = await store.queue({
        status: q.status,
        ...(q.band ? { band: q.band } : {}),
        ...(assignedTo ? { assignedTo } : {}),
        ...(q.search ? { search: q.search } : {}),
        ...(q.cursor ? { after: decodeCursor(q.cursor) } : {}),
        limit: q.limit + 1,
      });
      const page = rows.slice(0, q.limit);
      const at = now().getTime();
      const items: QueueItem[] = page.map((r) => ({
        sessionId: r.sessionId,
        status: r.status,
        customerName: maskName(r.fullName),
        submittedAt: r.submittedAt?.toISOString() ?? null,
        waitingDurationMinutes: r.submittedAt
          ? Math.max(0, Math.floor((at - r.submittedAt.getTime()) / 60_000))
          : null,
        riskBand: r.band,
        triggeredRuleCount: r.triggeredRuleCount,
        assignedOfficerId: r.assignedOfficerId,
        assignedOfficerName: r.assignedOfficerEmail,
        isLocked: r.assignedOfficerId !== null && r.assignedOfficerId !== actor.userId,
        flags: r.flags,
      }));
      const last = page.at(-1);
      return {
        items,
        nextCursor:
          rows.length > q.limit && last
            ? encodeCursor({
                rank: last.band ? RANK[last.band] : 0,
                at: (last.submittedAt ?? last.createdAt).toISOString(),
                id: last.sessionId,
              })
            : null,
        counts: await store.counts(q.status, actor.userId),
      };
    },

    /**
     * The auditor's search: every application in any state (approved, rejected and expired included), newest first, by
     * date range, decision type and status. Read-only, and the names are masked like everywhere else.
     */
    async auditSessions(q: AuditSessionsQuery): Promise<AuditSessionsResponse> {
      const after = q.cursor ? decodeAuditCursor(q.cursor) : undefined;
      const rows = await store.auditSessions({
        ...(q.status ? { status: q.status } : {}),
        ...(q.decision ? { decision: q.decision } : {}),
        ...(q.from ? { from: istDayBounds(q.from).from } : {}),
        ...(q.to ? { to: istDayBounds(q.to).to } : {}),
        ...(q.search ? { search: q.search } : {}),
        ...(after ? { after } : {}),
        limit: q.limit + 1,
      });
      const page = rows.slice(0, q.limit);
      const last = page.at(-1);
      return {
        items: page.map((r) => ({
          sessionId: r.sessionId,
          referenceId: referenceIdOf(r.sessionId),
          customerName: maskName(r.fullName),
          status: r.status,
          createdAt: r.createdAt.toISOString(),
          submittedAt: r.submittedAt?.toISOString() ?? null,
          riskBand: r.band,
          decision: r.decision,
          decidedAt: r.decidedAt?.toISOString() ?? null,
        })),
        nextCursor:
          rows.length > q.limit && last
            ? Buffer.from(
                JSON.stringify({
                  at: (last.submittedAt ?? last.createdAt).toISOString(),
                  id: last.sessionId,
                }),
              ).toString('base64url')
            : null,
      };
    },

    // ---- claim / release / take over ----------------------------------------------------------------------

    async claim(actor: Actor, sessionId: string): Promise<AssignmentDto> {
      const session = await loadSession(sessionId);
      requireUnderReview(session);
      assertFourEyes(session, actor.userId);
      const res = await store.claim(sessionId, actor.userId, (a) =>
        audit(actor, AUDIT_ACTIONS.ASSIGNMENT_CLAIMED, sessionId, { assignmentId: a.id }),
      );
      if (res.kind === 'conflict') throw heldByOther(res.assignment);
      return toAssignmentDto(res.assignment, actor.userId);
    },

    async release(actor: Actor, sessionId: string): Promise<boolean> {
      await loadSession(sessionId);
      return store.release(sessionId, actor.userId, () =>
        audit(actor, AUDIT_ACTIONS.ASSIGNMENT_RELEASED, sessionId, {}),
      );
    },

    async takeOver(
      actor: Actor,
      sessionId: string,
    ): Promise<{ assignment: AssignmentDto; previousOfficerName: string | null }> {
      const session = await loadSession(sessionId);
      requireUnderReview(session);
      assertFourEyes(session, actor.userId);
      const res = await store.takeOver(sessionId, actor.userId, (next, previous) =>
        previous
          ? audit(actor, AUDIT_ACTIONS.ASSIGNMENT_TAKEN_OVER, sessionId, {
              assignmentId: next.id,
              fromOfficerId: previous.officerId,
              toOfficerId: actor.userId,
            })
          : audit(actor, AUDIT_ACTIONS.ASSIGNMENT_CLAIMED, sessionId, { assignmentId: next.id }),
      );
      return {
        assignment: toAssignmentDto(res.assignment, actor.userId),
        previousOfficerName: res.previous?.officerEmail ?? null,
      };
    },

    async myAssignments(actor: Actor) {
      const rows = await store.myAssignments(actor.userId);
      return {
        assignments: rows.map((r) => ({
          sessionId: r.sessionId,
          customerName: maskName(r.fullName),
          status: r.status,
          riskBand: r.band,
          assignedAt: r.assignedAt.toISOString(),
          submittedAt: r.submittedAt?.toISOString() ?? null,
        })),
      };
    },

    // ---- the one-shot review payload ------------------------------------------------------------------------

    async review(actor: Actor, sessionId: string, meta: RequestMeta): Promise<ReviewPayload> {
      const session = await loadSession(sessionId);
      const g = await gather(session);

      // Every signed URL is issued (and logged) separately, on every load, before the timeline is read,
      // so the timeline the officer sees already contains the links this very page load created.
      const documents = await Promise.all(
        g.activeDocs.map(async (d) => ({
          id: d.id,
          type: d.type,
          mimeType: d.mimeType,
          sizeBytes: d.sizeBytes,
          sha256: d.sha256,
          uploadedAt: d.uploadedAt.toISOString(),
          previewUrl: await docs.issueOfficerUrl(actor.userId, d, meta),
        })),
      );
      await store.writeAudit(
        audit(actor, AUDIT_ACTIONS.OFFICER_REVIEW_OPENED, sessionId, {
          signedUrlCount: documents.length,
        }),
      );

      const [auditRows, decisions, assignmentRow, reveal, consent] = await Promise.all([
        store.sessionAudit(sessionId),
        store.decisionsFor(sessionId),
        store.activeAssignment(sessionId),
        store.lastReveal(sessionId),
        session.consentVersionId ? kycStore.findConsentById(session.consentVersionId) : null,
      ]);
      const users = await nameMap([
        ...auditRows.map((r) => r.actorId),
        ...decisions.map((d) => d.officerId),
        reveal?.actorId ?? null,
        actor.userId,
      ]);

      const plain = decryptStored(session.personalDetails, piiKey);
      // Serialization is the one place that decides what a role may see: the handler never builds this by hand.
      const personal = maskForRole(plain, actor.role);
      const resubmitCount = decisions.filter((d) => d.decision === 'REQUEST_RESUBMIT').length;
      const blockers = blockersFor(actor, session, assignmentRow);

      return {
        generatedAt: now().toISOString(),
        viewer: {
          officerId: actor.userId,
          displayName: displayName(users.get(actor.userId)),
          role: actor.role,
          canWrite: isWriter(actor.role),
        },
        session: {
          id: session.id,
          status: session.status,
          createdAt: session.createdAt.toISOString(),
          submittedAt: session.submittedAt?.toISOString() ?? null,
          expiresAt: session.expiresAt.toISOString(),
          flags: session.flags,
          resubmitCount,
          consent: consent
            ? {
                versionId: consent.id,
                version: consent.version,
                acceptedAt: session.consentAcceptedAt?.toISOString() ?? null,
                effectiveFrom: consent.effectiveFrom.toISOString(),
                supersededAt: consent.supersededAt?.toISOString() ?? null,
                snippet: snippetOf(consent.bodyMarkdown),
                sha256: sha256Hex(consent.bodyMarkdown),
                textSnapshot: consent.bodyMarkdown,
              }
            : null,
        },
        customer: {
          displayName: maskName(typeof plain['fullName'] === 'string' ? plain['fullName'] : null),
          personal,
        },
        documents,
        extractions: g.extractions.map(toReviewExtraction),
        comparison: g.comparison,
        faceMatch: g.faceMatch,
        liveness: g.liveness,
        risk: g.risk,
        audit: auditRows.map((r) => toAuditEntry(r, users)),
        decisions: decisions.map((d) => ({
          id: d.id,
          decision: d.decision,
          reasonCode: d.reasonCode,
          reasonNote: d.reasonNote,
          resubmitDocumentTypes: d.resubmitDocumentTypes,
          officerName: displayName(users.get(d.officerId)),
          createdAt: d.createdAt.toISOString(),
        })),
        assignment: assignmentRow ? toAssignmentDto(assignmentRow, actor.userId) : null,
        reveal: {
          lastRevealedBy: reveal?.actorId ? displayName(users.get(reveal.actorId)) : null,
          lastRevealedAt: reveal?.at.toISOString() ?? null,
        },
        decisionOptions: {
          allowed: blockers.length === 0,
          blockers,
          reasonCodes: {
            REJECT: [...REASON_CODES_BY_DECISION.REJECT],
            REQUEST_RESUBMIT: [...REASON_CODES_BY_DECISION.REQUEST_RESUBMIT],
          },
          resubmitRemaining: Math.max(0, MAX_RESUBMISSIONS - resubmitCount),
        },
      };
    },

    /**
     * The only way to see a full Aadhaar number. Needs the active claim, and the audit row is written BEFORE
     * the value is returned, so a failure to log means no reveal. The row says `revealed: true` and nothing else.
     */
    async reveal(actor: Actor, sessionId: string): Promise<RevealResponse> {
      const session = await loadSession(sessionId);
      assertFourEyes(session, actor.userId);
      const assignment = await store.activeAssignment(sessionId);
      if (!assignment) {
        throw new AppError(409, 'NOT_CLAIMED', 'Claim this application before revealing details');
      }
      if (assignment.officerId !== actor.userId) throw heldByOther(assignment);

      const plain = decryptStored(session.personalDetails, piiKey);
      const revealedAt = now();
      // The number leaves only through maskForRole, tagged as revealed, and only for a role that may have it.
      const masked = maskForRole(plain, actor.role, { reveal: { at: revealedAt } });
      if (!masked.aadhaar) {
        throw new AppError(404, 'NO_AADHAAR', 'No Aadhaar number was entered for this application');
      }
      await store.writeAudit(
        audit(actor, AUDIT_ACTIONS.AADHAAR_REVEALED, sessionId, { revealed: true }),
      );
      const me = await store.findUsers([actor.userId]);
      return {
        field: 'AADHAAR',
        value: masked.aadhaar.value,
        revealed: true,
        revealedAt: masked.aadhaar.revealedAt,
        revealedBy: displayName(me[0]),
      };
    },

    // ---- decisions -------------------------------------------------------------------------------------------

    async decide(
      actor: Actor,
      sessionId: string,
      body: DecisionRequest,
    ): Promise<DecisionResponse> {
      const session = await loadSession(sessionId);
      if (session.status !== 'UNDER_REVIEW') {
        throw new AppError(
          409,
          'INVALID_STATE',
          `This application is ${session.status}; only applications under review can be decided`,
        );
      }
      assertFourEyes(session, actor.userId);
      const assignment = await store.activeAssignment(sessionId);
      if (!assignment) {
        throw new AppError(409, 'NOT_CLAIMED', 'Claim this application before deciding');
      }
      if (assignment.officerId !== actor.userId) throw heldByOther(assignment);

      if (body.decision === 'REQUEST_RESUBMIT') {
        if ((await store.countResubmits(sessionId)) >= MAX_RESUBMISSIONS) {
          throw new AppError(
            409,
            'RESUBMIT_LIMIT_REACHED',
            `This application was already sent back ${MAX_RESUBMISSIONS} times. Approve or reject it.`,
          );
        }
      }

      const to = NEXT_STATUS[body.decision];
      const { session: nextState, audit: transitionAudit } = applyTransition(
        toState(session),
        to,
        actor.userId,
        now(),
      );
      const resubmitTypes = body.decision === 'REQUEST_RESUBMIT' ? body.resubmitDocumentTypes : [];
      const patch = {
        ...patchFrom(nextState),
        resubmitTypes,
        ...(body.decision === 'REQUEST_RESUBMIT'
          ? {
              currentStep: 'DOCUMENTS' as const,
              completedSteps: nextState.completedSteps.filter(
                (s) => !(REDONE_STEPS as readonly string[]).includes(s),
              ),
            }
          : {}),
      };

      const reasonCode = body.decision === 'APPROVE' ? null : body.reasonCode;
      const result = await store.recordDecision({
        sessionId,
        officerId: actor.userId,
        decision: body.decision,
        reasonCode,
        reasonNote: body.reasonNote?.trim() ? body.reasonNote.trim() : null,
        resubmitDocumentTypes: resubmitTypes,
        snapshot: await buildSnapshot(session, assignment, actor.userId),
        fromStatus: 'UNDER_REVIEW',
        sessionPatch: patch,
        clearDocumentTypes: resubmitTypes,
        audits: (d, cleared) => [
          transitionAudit,
          // Ids and codes only. The officer's note is stored on the decision, never in the audit trail.
          audit(actor, AUDIT_ACTIONS.DECISION_RECORDED, sessionId, {
            decisionId: d.id,
            decision: d.decision,
            reasonCode: d.reasonCode,
            officerId: actor.userId,
            ...(resubmitTypes.length > 0 ? { resubmitDocumentTypes: resubmitTypes } : {}),
          }),
          ...(cleared.length > 0
            ? [
                audit(actor, AUDIT_ACTIONS.KYC_DOCUMENTS_CLEARED, sessionId, {
                  decisionId: d.id,
                  documentIds: cleared.map((c) => c.id),
                  types: cleared.map((c) => c.type),
                }),
              ]
            : []),
        ],
      });
      if (result.kind === 'session-changed') {
        throw new AppError(409, 'INVALID_STATE', 'The application changed while you were deciding');
      }
      if (result.kind === 'not-assignee') {
        const current = await store.activeAssignment(sessionId);
        throw current
          ? heldByOther(current)
          : new AppError(409, 'NOT_CLAIMED', 'You no longer hold this application');
      }

      // The decision is committed; telling the customer is best effort and must never undo it.
      try {
        await deps.enqueuer.enqueueNotification(result.decision.id);
        await store.writeAudit(
          audit(null, AUDIT_ACTIONS.NOTIFICATION_QUEUED, sessionId, {
            decisionId: result.decision.id,
          }),
        );
      } catch (err) {
        log.error({ err }, 'could not queue the customer notification');
        await store.writeAudit(
          audit(null, AUDIT_ACTIONS.NOTIFICATION_ENQUEUE_FAILED, sessionId, {
            decisionId: result.decision.id,
          }),
        );
      }
      return {
        decisionId: result.decision.id,
        decision: result.decision.decision,
        sessionStatus: to,
        createdAt: result.decision.createdAt.toISOString(),
      };
    },
  };
}
export type OfficerService = ReturnType<typeof createOfficerService>;
