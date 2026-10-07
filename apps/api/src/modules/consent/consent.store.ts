import { Prisma } from '@kyc-setu/db';
import type { SafeClient } from '../../db/safeClient.js';
import type { AuditEntry } from '../auth/store.js';

export interface ConsentVersionRecord {
  id: string;
  version: string;
  bodyMarkdown: string;
  effectiveFrom: Date;
  supersededAt: Date | null;
  createdAt: Date;
}

export interface ReviseInput {
  version: string;
  bodyMarkdown: string;
  effectiveFrom: Date;
  now: Date;
}

export interface ReviseResult {
  created: ConsentVersionRecord;
  superseded: ConsentVersionRecord | null;
}

export interface ConsentStore {
  /** The version customers are asked to accept: the newest that is not superseded and already in force. */
  current(now: Date): Promise<ConsentVersionRecord | null>;
  /** The newest version that is not superseded, even one that comes into force later. */
  latest(): Promise<ConsentVersionRecord | null>;
  /**
   * In ONE transaction: insert the new version and set `supersededAt` on the one it replaces. Either both happen or
   * neither does, so there is never a moment with two current versions or none.
   */
  revise(
    input: ReviseInput,
    audit: (r: ReviseResult) => AuditEntry,
  ): Promise<ReviseResult | 'DUPLICATE_VERSION'>;
}

export function createPrismaConsentStore(prisma: SafeClient): ConsentStore {
  return {
    current: (now) =>
      prisma.consentVersion.findFirst({
        where: { supersededAt: null, effectiveFrom: { lte: now } },
        orderBy: { effectiveFrom: 'desc' },
      }),

    latest: () =>
      prisma.consentVersion.findFirst({
        where: { supersededAt: null },
        orderBy: { effectiveFrom: 'desc' },
      }),

    async revise(input, audit) {
      try {
        return await prisma.$transaction(async (tx) => {
          const previous = await tx.consentVersion.findFirst({
            where: { supersededAt: null },
            orderBy: { effectiveFrom: 'desc' },
          });
          const created = await tx.consentVersion.create({
            data: {
              version: input.version,
              bodyMarkdown: input.bodyMarkdown,
              effectiveFrom: input.effectiveFrom,
            },
          });
          const superseded = previous
            ? await tx.consentVersion.update({
                where: { id: previous.id },
                data: { supersededAt: input.now },
              })
            : null;
          const result = { created, superseded };
          const e = audit(result);
          await tx.auditLog.create({
            data: {
              actorId: e.actorId,
              actorType: e.actorType,
              action: e.action,
              entityType: e.entityType,
              entityId: e.entityId,
              metadata: e.metadata ?? {},
            },
          });
          return result;
        });
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002')
          return 'DUPLICATE_VERSION';
        throw err;
      }
    },
  };
}
