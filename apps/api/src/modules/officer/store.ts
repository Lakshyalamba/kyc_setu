import { Prisma } from '@kyc-setu/db';
import type { SafeClient } from '../../db/safeClient.js';
import type {
  DecisionTypeName,
  DocumentType,
  KycStatus,
  ReasonCodeName,
  Role,
} from '@kyc-setu/shared';
import type { AuditEntry } from '../auth/store.js';
import type { SessionPatch } from '../kyc/store.js';

export type Band = 'LOW' | 'MEDIUM' | 'HIGH';

/** Keyset position in the queue: band rank (HIGH first), then oldest first, then id as the tie-break. */
export interface QueueCursor {
  rank: number;
  at: string;
  id: string;
}

export interface QueueFilter {
  status: KycStatus;
  band?: Band;
  assignedTo?: { kind: 'officer'; officerId: string } | { kind: 'unassigned' };
  search?: string;
  after?: QueueCursor;
  /** Rows to return; the service asks for one extra to learn whether there is another page. */
  limit: number;
}

export interface QueueRow {
  sessionId: string;
  status: KycStatus;
  createdAt: Date;
  submittedAt: Date | null;
  fullName: string | null;
  band: Band | null;
  triggeredRuleCount: number;
  assignedOfficerId: string | null;
  assignedOfficerEmail: string | null;
  assignedAt: Date | null;
  flags: string[];
}

export interface QueueCounts {
  HIGH: number;
  MEDIUM: number;
  LOW: number;
  total: number;
  assignedToMe: number;
  unassigned: number;
}

export interface AssignmentRecord {
  id: string;
  sessionId: string;
  officerId: string;
  officerEmail: string;
  assignedAt: Date;
}

export interface UserSummary {
  id: string;
  email: string;
  role: Role;
}

export interface DecisionRecord {
  id: string;
  sessionId: string;
  officerId: string;
  decision: DecisionTypeName;
  reasonCode: ReasonCodeName | null;
  reasonNote: string | null;
  resubmitDocumentTypes: DocumentType[];
  snapshot: unknown;
  createdAt: Date;
}

export interface AuditRow {
  id: string;
  actorId: string | null;
  actorType: 'USER' | 'SYSTEM' | 'AI';
  action: string;
  entityType: string;
  entityId: string;
  metadata: unknown;
  createdAt: Date;
}

export interface MyAssignmentRow {
  sessionId: string;
  fullName: string | null;
  status: KycStatus;
  band: Band | null;
  assignedAt: Date;
  submittedAt: Date | null;
}

export type ClaimResult =
  | { kind: 'created'; assignment: AssignmentRecord }
  | { kind: 'existing'; assignment: AssignmentRecord }
  | { kind: 'conflict'; assignment: AssignmentRecord };

export interface RecordDecisionInput {
  sessionId: string;
  officerId: string;
  decision: DecisionTypeName;
  reasonCode: ReasonCodeName | null;
  reasonNote: string | null;
  resubmitDocumentTypes: DocumentType[];
  /** Everything the review page showed, frozen. */
  snapshot: unknown;
  /** The status the session must still be in; the write is a compare-and-set on it. */
  fromStatus: KycStatus;
  sessionPatch: SessionPatch;
  /** Active documents of these types are soft-deleted in the same transaction (a resubmission request). */
  clearDocumentTypes: DocumentType[];
  audits: (
    decision: DecisionRecord,
    clearedDocuments: { id: string; type: DocumentType }[],
  ) => AuditEntry[];
}

export type RecordDecisionResult =
  { kind: 'ok'; decision: DecisionRecord } | { kind: 'session-changed' } | { kind: 'not-assignee' };

/** Persistence seam for the officer workbench; Prisma in production, an in-memory fake in unit tests. */
export interface OfficerStore {
  queue(filter: QueueFilter): Promise<QueueRow[]>;
  counts(status: KycStatus, officerId: string): Promise<QueueCounts>;

  activeAssignment(sessionId: string): Promise<AssignmentRecord | null>;
  /** Idempotent for the same officer; a different holder is reported, never overwritten. */
  claim(
    sessionId: string,
    officerId: string,
    audit: (a: AssignmentRecord) => AuditEntry,
  ): Promise<ClaimResult>;
  /** Ends the officer's own assignment. False if they did not hold one. */
  release(
    sessionId: string,
    officerId: string,
    audit: (a: { sessionId: string }) => AuditEntry,
  ): Promise<boolean>;
  /** Ends whoever holds it and starts the caller's. `previous` is null when nobody held it. */
  takeOver(
    sessionId: string,
    officerId: string,
    audit: (next: AssignmentRecord, previous: AssignmentRecord | null) => AuditEntry,
  ): Promise<{ assignment: AssignmentRecord; previous: AssignmentRecord | null; changed: boolean }>;
  myAssignments(officerId: string): Promise<MyAssignmentRow[]>;

  findUsers(ids: string[]): Promise<UserSummary[]>;
  /** Audit rows about the session and about any of its documents (replaced ones included), oldest first. */
  sessionAudit(sessionId: string): Promise<AuditRow[]>;
  lastReveal(sessionId: string): Promise<{ actorId: string | null; at: Date } | null>;

  decisionsFor(sessionId: string): Promise<DecisionRecord[]>;
  findDecision(id: string): Promise<DecisionRecord | null>;
  latestDecision(sessionId: string): Promise<DecisionRecord | null>;
  countResubmits(sessionId: string): Promise<number>;
  /** Documents (and their total size) of sessions whose final decision was before `cutoff`: past their retention period. */
  documentsDecidedBefore(
    cutoff: Date,
  ): Promise<{ documents: number; sessions: number; bytes: number }>;
  /**
   * One transaction: compare-and-set the session status, end the officer's assignment, insert the decision,
   * clear documents (resubmission), write the audit rows. Nothing is written unless all of it succeeds.
   */
  recordDecision(input: RecordDecisionInput): Promise<RecordDecisionResult>;

  writeAudit(entry: AuditEntry): Promise<void>;
}

// ---- Prisma implementation -------------------------------------------------------------------------------------

const auditData = (e: AuditEntry) => ({
  actorId: e.actorId,
  actorType: e.actorType,
  action: e.action,
  entityType: e.entityType,
  entityId: e.entityId,
  metadata: e.metadata ?? {},
});

const json = (v: unknown) => v as Prisma.InputJsonValue;
const BAND_RANK = Prisma.sql`CASE ra.band WHEN 'HIGH' THEN 3 WHEN 'MEDIUM' THEN 2 WHEN 'LOW' THEN 1 ELSE 0 END`;

/** Escapes LIKE wildcards so a search for "100%" means exactly that. */
const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

const isUniqueViolation = (err: unknown) =>
  err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';

class Rollback extends Error {
  constructor(public readonly result: 'session-changed' | 'not-assignee') {
    super(result);
  }
}

type DbDecision = Prisma.DecisionGetPayload<object>;
const toDecision = (d: DbDecision): DecisionRecord => ({
  ...d,
  resubmitDocumentTypes: d.resubmitDocumentTypes,
});

type DbAssignment = Prisma.OfficerAssignmentGetPayload<{
  include: { officer: { select: { email: true } } };
}>;
const toAssignment = (a: DbAssignment): AssignmentRecord => ({
  id: a.id,
  sessionId: a.sessionId,
  officerId: a.officerId,
  officerEmail: a.officer.email,
  assignedAt: a.assignedAt,
});

export function createPrismaOfficerStore(prisma: SafeClient): OfficerStore {
  const withOfficer = { officer: { select: { email: true } } } as const;

  /** The latest risk assessment and the active assignment of every session, joined once. */
  const base = Prisma.sql`
    FROM kyc_sessions s
    LEFT JOIN LATERAL (
      SELECT r.band, r."triggeredRules"
      FROM risk_assessments r
      WHERE r."sessionId" = s.id
      ORDER BY r."createdAt" DESC
      LIMIT 1
    ) ra ON TRUE
    LEFT JOIN officer_assignments a ON a."sessionId" = s.id AND a."isActive"
    LEFT JOIN users u ON u.id = a."officerId"`;

  async function findActive(sessionId: string): Promise<AssignmentRecord | null> {
    const row = await prisma.officerAssignment.findFirst({
      where: { sessionId, isActive: true },
      include: withOfficer,
    });
    return row ? toAssignment(row) : null;
  }

  return {
    async queue(f) {
      const where: Prisma.Sql[] = [Prisma.sql`s.status = ${f.status}::"KycStatus"`];
      if (f.band) where.push(Prisma.sql`ra.band = ${f.band}::"RiskBand"`);
      if (f.assignedTo?.kind === 'officer')
        where.push(Prisma.sql`a."officerId" = ${f.assignedTo.officerId}::uuid`);
      if (f.assignedTo?.kind === 'unassigned') where.push(Prisma.sql`a.id IS NULL`);
      if (f.search) {
        const like = `${escapeLike(f.search)}%`;
        where.push(
          Prisma.sql`(s.id::text ILIKE ${like} OR (s."personalDetails" ->> 'fullName') ILIKE ${like})`,
        );
      }
      const after = f.after
        ? Prisma.sql`WHERE q."bandRank" < ${f.after.rank}
            OR (q."bandRank" = ${f.after.rank}
                AND (q."sortAt" > ${f.after.at}::timestamp
                     OR (q."sortAt" = ${f.after.at}::timestamp AND q.id > ${f.after.id}::uuid)))`
        : Prisma.empty;
      const rows = await prisma.$queryRaw<
        {
          sessionId: string;
          status: KycStatus;
          createdAt: Date;
          submittedAt: Date | null;
          fullName: string | null;
          band: Band | null;
          triggeredRuleCount: number;
          assignedOfficerId: string | null;
          assignedOfficerEmail: string | null;
          assignedAt: Date | null;
          flags: string[];
        }[]
      >(Prisma.sql`
        SELECT q.id AS "sessionId", q.status, q."createdAt", q."submittedAt", q."fullName", q.band,
               q."triggeredRuleCount", q."assignedOfficerId", q."assignedOfficerEmail", q."assignedAt", q.flags
        FROM (
          SELECT s.id, s.status::text AS status, s."createdAt", s."submittedAt",
                 COALESCE(s."submittedAt", s."createdAt") AS "sortAt",
                 ${BAND_RANK}::int AS "bandRank",
                 s."personalDetails" ->> 'fullName' AS "fullName",
                 ra.band::text AS band,
                 COALESCE(jsonb_array_length(ra."triggeredRules"), 0)::int AS "triggeredRuleCount",
                 a."officerId" AS "assignedOfficerId", u.email AS "assignedOfficerEmail",
                 a."assignedAt", s.flags
          ${base}
          WHERE ${Prisma.join(where, ' AND ')}
        ) q
        ${after}
        ORDER BY q."bandRank" DESC, q."sortAt" ASC, q.id ASC
        LIMIT ${f.limit}`);
      return rows;
    },

    async counts(status, officerId) {
      const rows = await prisma.$queryRaw<
        { band: string | null; assigned: boolean; mine: boolean; n: number }[]
      >(Prisma.sql`
        SELECT ra.band::text AS band, (a.id IS NOT NULL) AS assigned,
               COALESCE(a."officerId" = ${officerId}::uuid, FALSE) AS mine, count(*)::int AS n
        ${base}
        WHERE s.status = ${status}::"KycStatus"
        GROUP BY 1, 2, 3`);
      const out: QueueCounts = {
        HIGH: 0,
        MEDIUM: 0,
        LOW: 0,
        total: 0,
        assignedToMe: 0,
        unassigned: 0,
      };
      for (const r of rows) {
        out.total += r.n;
        if (r.band === 'HIGH' || r.band === 'MEDIUM' || r.band === 'LOW') out[r.band] += r.n;
        if (r.mine) out.assignedToMe += r.n;
        if (!r.assigned) out.unassigned += r.n;
      }
      return out;
    },

    activeAssignment: findActive,

    async claim(sessionId, officerId, audit) {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          return await prisma.$transaction(async (tx): Promise<ClaimResult> => {
            const existing = await tx.officerAssignment.findFirst({
              where: { sessionId, isActive: true },
              include: withOfficer,
            });
            if (existing) {
              return {
                kind: existing.officerId === officerId ? 'existing' : 'conflict',
                assignment: toAssignment(existing),
              };
            }
            const created = await tx.officerAssignment.create({
              data: { sessionId, officerId },
              include: withOfficer,
            });
            const assignment = toAssignment(created);
            await tx.auditLog.create({ data: auditData(audit(assignment)) });
            return { kind: 'created', assignment };
          });
        } catch (err) {
          if (!isUniqueViolation(err)) throw err; // lost the race for the one-active-per-session slot: look again
        }
      }
      throw new Error('could not settle the assignment');
    },

    async release(sessionId, officerId, audit) {
      return prisma.$transaction(async (tx) => {
        const res = await tx.officerAssignment.updateMany({
          where: { sessionId, officerId, isActive: true },
          data: { isActive: false, releasedAt: new Date() },
        });
        if (res.count === 0) return false;
        await tx.auditLog.create({ data: auditData(audit({ sessionId })) });
        return true;
      });
    },

    async takeOver(sessionId, officerId, audit) {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          return await prisma.$transaction(async (tx) => {
            const existing = await tx.officerAssignment.findFirst({
              where: { sessionId, isActive: true },
              include: withOfficer,
            });
            if (existing?.officerId === officerId) {
              return { assignment: toAssignment(existing), previous: null, changed: false };
            }
            if (existing) {
              await tx.officerAssignment.update({
                where: { id: existing.id },
                data: { isActive: false, releasedAt: new Date() },
              });
            }
            const created = await tx.officerAssignment.create({
              data: { sessionId, officerId },
              include: withOfficer,
            });
            const previous = existing ? toAssignment(existing) : null;
            const assignment = toAssignment(created);
            await tx.auditLog.create({ data: auditData(audit(assignment, previous)) });
            return { assignment, previous, changed: true };
          });
        } catch (err) {
          if (!isUniqueViolation(err)) throw err;
        }
      }
      throw new Error('could not settle the assignment');
    },

    async myAssignments(officerId) {
      const rows = await prisma.officerAssignment.findMany({
        where: { officerId, isActive: true },
        orderBy: { assignedAt: 'asc' },
        include: {
          session: {
            select: {
              status: true,
              submittedAt: true,
              personalDetails: true,
              riskAssessments: { orderBy: { createdAt: 'desc' }, take: 1, select: { band: true } },
            },
          },
        },
      });
      return rows.map((r) => ({
        sessionId: r.sessionId,
        fullName:
          typeof (r.session.personalDetails as { fullName?: unknown } | null)?.fullName === 'string'
            ? (r.session.personalDetails as { fullName: string }).fullName
            : null,
        status: r.session.status,
        band: r.session.riskAssessments[0]?.band ?? null,
        assignedAt: r.assignedAt,
        submittedAt: r.session.submittedAt,
      }));
    },

    findUsers: (ids) =>
      ids.length === 0
        ? Promise.resolve([])
        : prisma.user.findMany({
            where: { id: { in: ids } },
            select: { id: true, email: true, role: true },
          }),

    async sessionAudit(sessionId) {
      const docs = await prisma.document.findMany({ where: { sessionId }, select: { id: true } });
      const rows = await prisma.auditLog.findMany({
        where: {
          OR: [
            { entityType: 'KycSession', entityId: sessionId },
            { entityType: 'Document', entityId: { in: docs.map((d) => d.id) } },
          ],
        },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: 2000,
      });
      return rows;
    },

    async lastReveal(sessionId) {
      const row = await prisma.auditLog.findFirst({
        where: { entityType: 'KycSession', entityId: sessionId, action: 'aadhaar.revealed' },
        orderBy: { createdAt: 'desc' },
        select: { actorId: true, createdAt: true },
      });
      return row ? { actorId: row.actorId, at: row.createdAt } : null;
    },

    async decisionsFor(sessionId) {
      return (
        await prisma.decision.findMany({ where: { sessionId }, orderBy: { createdAt: 'asc' } })
      ).map(toDecision);
    },
    async findDecision(id) {
      const row = await prisma.decision.findUnique({ where: { id } });
      return row ? toDecision(row) : null;
    },
    async latestDecision(sessionId) {
      const row = await prisma.decision.findFirst({
        where: { sessionId },
        orderBy: { createdAt: 'desc' },
      });
      return row ? toDecision(row) : null;
    },
    countResubmits: (sessionId) =>
      prisma.decision.count({ where: { sessionId, decision: 'REQUEST_RESUBMIT' } }),

    async documentsDecidedBefore(cutoff) {
      const [row] = await prisma.$queryRaw<
        { documents: number; sessions: number; bytes: number | null }[]
      >`
        SELECT count(d.id)::int AS documents, count(DISTINCT s.id)::int AS sessions, COALESCE(sum(d."sizeBytes"), 0)::int AS bytes
        FROM kyc_sessions s
        JOIN documents d ON d."sessionId" = s.id
        WHERE s.status IN ('APPROVED', 'REJECTED')
          AND (SELECT max(dec."createdAt") FROM decisions dec WHERE dec."sessionId" = s.id) < ${cutoff}`;
      return {
        documents: row?.documents ?? 0,
        sessions: row?.sessions ?? 0,
        bytes: row?.bytes ?? 0,
      };
    },

    async recordDecision(input) {
      try {
        return await prisma.$transaction(async (tx): Promise<RecordDecisionResult> => {
          // 1. The compare-and-set: only one decision can ever move a session out of UNDER_REVIEW.
          const { personalDetails, ...patch } = input.sessionPatch;
          const moved = await tx.kycSession.updateMany({
            where: { id: input.sessionId, status: input.fromStatus },
            data: {
              ...patch,
              ...(personalDetails ? { personalDetails: json(personalDetails) } : {}),
            },
          });
          if (moved.count === 0) throw new Rollback('session-changed');

          // 2. The officer must still hold the assignment (take-over ends the previous holder's).
          const released = await tx.officerAssignment.updateMany({
            where: { sessionId: input.sessionId, officerId: input.officerId, isActive: true },
            data: { isActive: false, releasedAt: new Date() },
          });
          if (released.count === 0) throw new Rollback('not-assignee');

          // 3. A resubmission request empties the requested slots. Soft delete, like every document removal:
          //    the row and the ciphertext stay, and the previous snapshot still points at them.
          let cleared: { id: string; type: DocumentType }[] = [];
          if (input.clearDocumentTypes.length > 0) {
            cleared = await tx.document.findMany({
              where: {
                sessionId: input.sessionId,
                type: { in: input.clearDocumentTypes },
                replacedById: null,
              },
              select: { id: true, type: true },
            });
            if (cleared.length > 0) {
              await tx.$executeRaw(
                Prisma.sql`UPDATE documents SET "replacedById" = id
                           WHERE id IN (${Prisma.join(cleared.map((d) => Prisma.sql`${d.id}::uuid`))})`,
              );
            }
          }

          const row = await tx.decision.create({
            data: {
              sessionId: input.sessionId,
              officerId: input.officerId,
              decision: input.decision,
              reasonCode: input.reasonCode,
              reasonNote: input.reasonNote,
              resubmitDocumentTypes: input.resubmitDocumentTypes,
              snapshot: json(input.snapshot),
            },
          });
          const decision = toDecision(row);
          await tx.auditLog.createMany({ data: input.audits(decision, cleared).map(auditData) });
          return { kind: 'ok', decision };
        });
      } catch (err) {
        if (err instanceof Rollback) return { kind: err.result };
        throw err;
      }
    },

    async writeAudit(entry) {
      await prisma.auditLog.create({ data: auditData(entry) });
    },
  };
}
