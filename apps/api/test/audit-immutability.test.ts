// Real Postgres. The audit log is the one table nobody may rewrite: the database refuses (a trigger with no
// bypass flag), and the application's own client cannot even express it.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@kyc-setu/db';
import { createSafeClient } from '../src/db/safeClient.js';

const up = process.env['INFRA_UP'] === '1';
const dbUrl = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL'] ?? '';

describe.skipIf(!up)('audit_logs is append-only', () => {
  const raw = new PrismaClient({ datasourceUrl: dbUrl });
  const safe = createSafeClient(raw);
  let id: string;

  beforeAll(async () => {
    const row = await safe.auditLog.create({
      data: {
        actorType: 'SYSTEM',
        action: 'test.immutability',
        entityType: 'Test',
        entityId: randomUUID(),
        metadata: { n: 1 },
      },
    });
    id = row.id;
  });
  afterAll(async () => {
    await raw.$disconnect();
  });

  describe('in the database', () => {
    it('refuses a direct SQL UPDATE', async () => {
      await expect(
        raw.$executeRawUnsafe(`UPDATE audit_logs SET action = 'nothing' WHERE id = '${id}'::uuid`),
      ).rejects.toThrow(/audit_logs is append-only \(UPDATE not allowed\)/);
      const still = await raw.auditLog.findUniqueOrThrow({ where: { id } });
      expect(still.action).toBe('test.immutability');
    });

    it('refuses a direct SQL DELETE', async () => {
      await expect(
        raw.$executeRawUnsafe(`DELETE FROM audit_logs WHERE id = '${id}'::uuid`),
      ).rejects.toThrow(/audit_logs is append-only \(DELETE not allowed\)/);
      expect(await raw.auditLog.count({ where: { id } })).toBe(1);
    });

    it('refuses a bulk UPDATE and DELETE, row by row, even when nothing would change', async () => {
      await expect(raw.$executeRawUnsafe(`UPDATE audit_logs SET action = action`)).rejects.toThrow(
        /append-only/,
      );
      await expect(raw.$executeRawUnsafe(`DELETE FROM audit_logs`)).rejects.toThrow(/append-only/);
    });

    it('refuses what an unguarded Prisma client would try', async () => {
      await expect(raw.auditLog.update({ where: { id }, data: { action: 'x' } })).rejects.toThrow(
        /append-only/,
      );
      await expect(raw.auditLog.delete({ where: { id } })).rejects.toThrow(/append-only/);
      await expect(raw.auditLog.deleteMany({ where: { id } })).rejects.toThrow(/append-only/);
    });

    it('has no switch an application can flip: a session setting does not open it', async () => {
      await expect(
        raw.$transaction(async (tx) => {
          await tx.$executeRawUnsafe(`SET LOCAL app.allow_audit_write = 'on'`);
          await tx.$executeRawUnsafe(`SET LOCAL audit.bypass = 'true'`);
          await tx.$executeRawUnsafe(
            `UPDATE audit_logs SET action = 'nope' WHERE id = '${id}'::uuid`,
          );
        }),
      ).rejects.toThrow(/append-only/);
      expect((await raw.auditLog.findUniqueOrThrow({ where: { id } })).action).toBe(
        'test.immutability',
      );
    });

    it('still accepts new rows', async () => {
      const before = await raw.auditLog.count();
      await raw.$executeRawUnsafe(
        `INSERT INTO audit_logs (id, "actorType", action, "entityType", "entityId", metadata)
         VALUES (gen_random_uuid(), 'SYSTEM', 'test.insert', 'Test', 'x', '{}')`,
      );
      expect(await raw.auditLog.count()).toBe(before + 1);
    });
  });

  describe('in the application client', () => {
    it('does not offer update, updateMany, upsert, delete or deleteMany on auditLog (compile time)', () => {
      // Never called: this only has to type-check. Each @ts-expect-error line must be a type error; if one stops being
      // one, the unused directive breaks the build.
      const typesOnly = () => {
        // @ts-expect-error audit_logs is append-only
        void safe.auditLog.update;
        // @ts-expect-error audit_logs is append-only
        void safe.auditLog.updateMany;
        // @ts-expect-error audit_logs is append-only
        void safe.auditLog.upsert;
        // @ts-expect-error audit_logs is append-only
        void safe.auditLog.delete;
        // @ts-expect-error audit_logs is append-only
        void safe.auditLog.deleteMany;
        // ...while reading and appending are fine:
        void safe.auditLog.create;
        void safe.auditLog.createMany;
        void safe.auditLog.findMany;
        void safe.auditLog.count;
      };
      expect(typeof typesOnly).toBe('function');
    });

    it('throws if the types are bypassed', () => {
      const loose = safe as unknown as { auditLog: Record<string, (a: unknown) => unknown> };
      for (const method of ['update', 'updateMany', 'upsert', 'delete', 'deleteMany'])
        expect(() => loose.auditLog[method]!({}), method).toThrow(/append-only/);
    });

    it('applies inside an interactive transaction too', async () => {
      await safe.$transaction(async (tx) => {
        const typesOnly = () => {
          // @ts-expect-error audit_logs is append-only
          void tx.auditLog.update;
          // @ts-expect-error audit_logs is append-only
          void tx.auditLog.delete;
        };
        expect(typeof typesOnly).toBe('function');
        const loose = tx as unknown as { auditLog: Record<string, (a: unknown) => unknown> };
        expect(() => loose.auditLog['update']!({})).toThrow(/append-only/);
        await tx.auditLog.create({
          data: {
            actorType: 'SYSTEM',
            action: 'test.in_tx',
            entityType: 'Test',
            entityId: 'tx',
            metadata: {},
          },
        });
      });
      expect(await safe.auditLog.count({ where: { action: 'test.in_tx' } })).toBeGreaterThan(0);
    });

    it('leaves every other table and every other client feature alone', async () => {
      expect(await safe.user.count()).toBeGreaterThanOrEqual(0);
      const [a, b] = await safe.$transaction([safe.user.count(), safe.kycSession.count()]);
      expect(typeof a + typeof b).toBe('numbernumber');
      expect(await safe.$queryRaw`SELECT 1 AS one`).toEqual([{ one: 1 }]);
    });
  });
});
