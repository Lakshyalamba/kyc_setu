import type { Prisma, PrismaClient } from '@kyc-setu/db';

/**
 * A Prisma client that cannot rewrite history.
 *
 * The audit log is the one table that is never updated or deleted: if you think you need an `UPDATE audit_logs`,
 * write a new row instead. Postgres enforces that with a trigger. This enforces it earlier: the type of `auditLog`
 * has no `update`, `updateMany`, `upsert`, `delete` or `deleteMany`, so calling one does not compile, and a
 * runtime guard throws if the types are bypassed (an `as any`, a plain JS caller).
 *
 * What it cannot see is raw SQL (`$executeRaw`): the database trigger is the backstop for that, and the daily hash chain
 * is the backstop for anyone who can switch the trigger off.
 */
const FORBIDDEN = [
  'update',
  'updateMany',
  'updateManyAndReturn',
  'upsert',
  'delete',
  'deleteMany',
] as const;
type ForbiddenAuditLogMethod = (typeof FORBIDDEN)[number];

export type SafeAuditLog = Omit<PrismaClient['auditLog'], ForbiddenAuditLogMethod>;

/** The `tx` handed to an interactive transaction: same rule inside it. */
export type SafeTransaction = Omit<Prisma.TransactionClient, 'auditLog'> & {
  auditLog: SafeAuditLog;
};

export type SafeClient = Omit<PrismaClient, 'auditLog' | '$transaction' | '$extends'> & {
  auditLog: SafeAuditLog;
  $transaction: {
    <T>(
      fn: (tx: SafeTransaction) => Promise<T>,
      options?: {
        maxWait?: number;
        timeout?: number;
        isolationLevel?: Prisma.TransactionIsolationLevel;
      },
    ): Promise<T>;
    <P extends Prisma.PrismaPromise<unknown>[]>(
      queries: [...P],
      options?: { isolationLevel?: Prisma.TransactionIsolationLevel },
    ): Promise<{ [K in keyof P]: Awaited<P[K]> }>;
  };
};

const forbidden = new Set<string | symbol>(FORBIDDEN);

function guardAuditLog<T extends object>(delegate: T): T {
  return new Proxy(delegate, {
    get(target, prop, receiver) {
      if (forbidden.has(prop)) {
        throw new Error(
          `audit_logs is append-only: auditLog.${String(prop)}() is not allowed. Write a new row instead.`,
        );
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}

/** Wraps a client or a transaction client: `auditLog` is guarded, everything else passes straight through. */
function guard<T extends object>(client: T): T {
  return new Proxy(client, {
    get(target, prop) {
      if (prop === 'auditLog') return guardAuditLog((target as { auditLog: object }).auditLog);
      if (prop === '$transaction') {
        return (arg: unknown, options?: unknown) =>
          typeof arg === 'function'
            ? (target as PrismaClient).$transaction(
                (tx) => (arg as (tx: unknown) => Promise<unknown>)(guard(tx)),
                options as never,
              )
            : (target as PrismaClient).$transaction(arg as never, options as never);
      }
      const value = Reflect.get(target, prop, target) as unknown;
      return typeof value === 'function'
        ? (value as (...a: unknown[]) => unknown).bind(target)
        : value;
    },
  });
}

export function createSafeClient(prisma: PrismaClient): SafeClient {
  return guard(prisma) as unknown as SafeClient;
}
