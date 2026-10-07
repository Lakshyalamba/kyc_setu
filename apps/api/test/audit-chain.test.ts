// The daily hash chain on real Postgres: build it, verify it, then tamper with the log behind the trigger's back
// (session_replication_role = replica, which a superuser can use to skip triggers) and check that verification names
// the day and the row.
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@kyc-setu/db';
import { createSafeClient } from '../src/db/safeClient.js';
import { createRealApp } from './realApp.js';
import { hashPassword } from '../src/lib/password.js';
import {
  GENESIS_HASH,
  addDays,
  canonicalJson,
  canonicalRow,
  chainRows,
  istDay,
  istDayBounds,
  sha256,
} from '../src/modules/audit/chain.js';
import { createAuditChainService } from '../src/modules/audit/chain.service.js';
import { createPrismaAuditChainStore } from '../src/modules/audit/chain.store.js';

describe('canonical JSON and the hashing rule', () => {
  it('sorts keys at every level, drops whitespace and ignores undefined', () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: null } })).toBe(
      '{"a":{"c":null,"d":[3,{"y":2,"z":1}]},"b":1}',
    );
    expect(canonicalJson({ b: 1, a: undefined })).toBe('{"b":1}');
    expect(canonicalJson({ a: 1, b: 2 })).toBe(canonicalJson({ b: 2, a: 1 }));
    expect(canonicalJson('he said "hi"\n')).toBe('"he said \\"hi\\"\\n"');
    expect(canonicalJson([])).toBe('[]');
  });

  const row = (n: number) => ({
    id: `00000000-0000-4000-8000-00000000000${n}`,
    actorId: null,
    actorType: 'SYSTEM',
    action: `a${n}`,
    entityType: 'T',
    entityId: `e${n}`,
    metadata: { z: n, a: [n] },
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, n)),
  });

  it('chains forward: each hash covers its row and the hash before it, seeded for the first', () => {
    const rows = [row(1), row(2), row(3)];
    const { rowHashes, chainHash } = chainRows(rows, GENESIS_HASH);
    const h1 = sha256(canonicalRow(rows[0]!) + GENESIS_HASH);
    const h2 = sha256(canonicalRow(rows[1]!) + h1);
    const h3 = sha256(canonicalRow(rows[2]!) + h2);
    expect(rowHashes.map(([, h]) => h)).toEqual([h1, h2, h3]);
    expect(chainHash).toBe(h3);
    // A different seed (a different yesterday) changes every hash; an empty day passes the seed through.
    expect(chainRows(rows, sha256('other')).chainHash).not.toBe(chainHash);
    expect(chainRows([], 'abc').chainHash).toBe('abc');
  });

  it('is order-sensitive and change-sensitive', () => {
    const [a, b] = [row(1), row(2)] as const;
    expect(chainRows([a, b], GENESIS_HASH).chainHash).not.toBe(
      chainRows([b, a], GENESIS_HASH).chainHash,
    );
    expect(chainRows([{ ...a, action: 'changed' }, b], GENESIS_HASH).chainHash).not.toBe(
      chainRows([a, b], GENESIS_HASH).chainHash,
    );
    expect(canonicalRow({ ...a, metadata: { a: [1], z: 1 } })).toBe(canonicalRow(a)); // key order does not matter
  });

  it('counts days in IST: the bank day ends at 18:30 UTC', () => {
    expect(istDay(new Date('2026-10-17T18:29:59.999Z'))).toBe('2026-10-17');
    expect(istDay(new Date('2026-10-17T18:30:00.000Z'))).toBe('2026-10-18');
    expect(istDay(new Date('2026-10-18T00:00:00.000Z'))).toBe('2026-10-18');
    const { from, to } = istDayBounds('2026-10-18');
    expect(from.toISOString()).toBe('2026-10-17T18:30:00.000Z');
    expect(to.toISOString()).toBe('2026-10-18T18:30:00.000Z');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });
});

const up = process.env['INFRA_UP'] === '1';
const dbUrl = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL'] ?? '';

describe.skipIf(!up)('the audit chain on Postgres', () => {
  const raw = new PrismaClient({ datasourceUrl: dbUrl });
  const safe = createSafeClient(raw);
  const store = createPrismaAuditChainStore(safe);
  // "Now" is the 20th at 10:00 UTC; the 17th and 18th are closed days with rows, the 19th is closed and empty.
  const NOW = new Date('2026-10-20T10:00:00Z');
  const chain = createAuditChainService({ store, now: () => NOW });
  const ids: Record<string, string[]> = { d17: [], d18: [], today: [] };

  const insert = async (at: string, action: string) =>
    (
      await safe.auditLog.create({
        data: {
          actorType: 'SYSTEM',
          action,
          entityType: 'Test',
          entityId: 'chain',
          metadata: { n: Math.random() > 2 ? 0 : action },
          createdAt: new Date(at),
        },
      })
    ).id;

  /** What a database superuser can do: skip the trigger. This is the test-only tamper hook. */
  const bypass = (sql: string) =>
    raw.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica');
      await tx.$executeRawUnsafe(sql);
    });

  beforeAll(async () => {
    await raw.$executeRawUnsafe('TRUNCATE "audit_logs", "audit_chain_checkpoint" CASCADE');
    ids['d17']!.push(await insert('2026-10-17T06:00:00.000Z', 'd17.a'));
    ids['d17']!.push(await insert('2026-10-17T09:15:00.000Z', 'd17.b'));
    ids['d17']!.push(await insert('2026-10-17T18:29:59.999Z', 'd17.last-ms')); // 23:59:59.999 IST: still the 17th
    ids['d18']!.push(await insert('2026-10-17T18:30:00.000Z', 'd18.first-ms')); // 00:00:00.000 IST: the 18th
    ids['d18']!.push(await insert('2026-10-18T05:00:00.000Z', 'd18.b'));
    ids['d18']!.push(await insert('2026-10-18T05:00:00.000Z', 'd18.c')); // same instant: ordered by id
    ids['d18']!.push(await insert('2026-10-18T12:00:00.000Z', 'd18.d'));
    ids['today']!.push(await insert('2026-10-20T04:00:00.000Z', 'today.a'));
  });
  afterAll(async () => {
    await raw.$executeRawUnsafe('TRUNCATE "audit_logs", "audit_chain_checkpoint" CASCADE');
    await raw.$disconnect();
  });

  it('bootstraps from the first row, chains each closed day that has rows, and leaves today alone', async () => {
    const result = await chain.build();
    expect(result.throughDay).toBe('2026-10-19');
    expect(result.built.map((b) => [b.day, b.rows])).toEqual([
      ['2026-10-17', 3],
      ['2026-10-18', 4],
    ]);
    expect(result.emptyDays).toBe(1); // the 19th had nothing to chain
    const cps = await store.checkpointsBetween('2026-10-01', '2026-10-31');
    expect(cps.map((c) => c.chainDate)).toEqual(['2026-10-17', '2026-10-18']);
    expect(cps[0]).toMatchObject({
      rowCount: 3,
      previousCheckpointHash: GENESIS_HASH,
      startRowId: ids['d17']![0],
      endRowId: ids['d17']![2],
    });
    // The first row of the second day is seeded with the first day's chainHash.
    expect(cps[1]!.previousCheckpointHash).toBe(cps[0]!.chainHash);
    expect(cps[1]!.rowHashes.map(([id]) => id).sort()).toEqual([...ids['d18']!].sort());
  });

  it('computes the hash it says it does (checked against the raw rows, independently)', async () => {
    const [cp] = await store.checkpointsBetween('2026-10-17', '2026-10-17');
    const rows = await raw.auditLog.findMany({
      where: { id: { in: ids['d17']! } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    let prev = GENESIS_HASH;
    for (const r of rows) prev = sha256(canonicalRow(r) + prev);
    expect(cp!.chainHash).toBe(prev);
  });

  it('orders rows created at the same instant by id, so the chain does not depend on insertion order', async () => {
    const [, d18] = await store.checkpointsBetween('2026-10-17', '2026-10-18');
    const tie = ids['d18']!.slice(1, 3).sort();
    const order = d18!.rowHashes.map(([id]) => id);
    expect(order.indexOf(tie[0]!)).toBeLessThan(order.indexOf(tie[1]!));
    expect(order[0]).toBe(ids['d18']![0]); // the 00:00:00.000 IST row opens the 18th
  });

  it('is idempotent: building again, or twice at once, adds nothing', async () => {
    expect((await chain.build()).built).toEqual([]);
    const [a, b] = await Promise.all([chain.build(), chain.build()]);
    expect(a.built.length + b.built.length).toBe(0);
    expect((await store.checkpointsBetween('2026-10-01', '2026-10-31')).length).toBe(2);
  });

  it('verifies a clean two-day window, and verifying writes nothing', async () => {
    const logBefore = await raw.auditLog.count();
    const cpBefore = await raw.auditChainCheckpoint.count();
    const res = await chain.verify({ from: '2026-10-17', to: '2026-10-19' });
    expect(res.ok).toBe(true);
    expect(res.days.map((d) => [d.day, d.status, d.rows, d.checkpointRows])).toEqual([
      ['2026-10-17', 'PASS', 3, 3],
      ['2026-10-18', 'PASS', 4, 4],
    ]);
    expect(
      res.days.every((d) => d.divergence === null && d.expectedChainHash === d.actualChainHash),
    ).toBe(true);
    expect(res.uncheckedDays).toEqual([]);
    expect(await raw.auditLog.count()).toBe(logBefore);
    expect(await raw.auditChainCheckpoint.count()).toBe(cpBefore);
    // ...and it can be asked again for the same answer.
    expect(await chain.verify({ from: '2026-10-17', to: '2026-10-19' })).toMatchObject({
      ok: true,
    });
  });

  it('refuses nonsense ranges', async () => {
    await expect(chain.verify({ from: '2026-10-19', to: '2026-10-17' })).rejects.toThrow(
      /must not be after/,
    );
    await expect(chain.verify({ from: '2026-02-30', to: '2026-10-17' })).rejects.toThrow(
      /Invalid date/,
    );
    await expect(chain.verify({ from: '2020-01-01', to: '2026-10-17' })).rejects.toThrow(/at most/);
  });

  it('the checkpoint table is append-only too', async () => {
    await expect(
      raw.$executeRawUnsafe(`UPDATE audit_chain_checkpoint SET "rowCount" = 9`),
    ).rejects.toThrow(/append-only/);
    await expect(raw.$executeRawUnsafe(`DELETE FROM audit_chain_checkpoint`)).rejects.toThrow(
      /append-only/,
    );
    await expect(
      raw.$executeRawUnsafe(`UPDATE audit_chain_checkpoint SET "chainHash" = 'nope'`),
    ).rejects.toThrow(/append-only/);
  });

  describe('tampering behind the trigger (a superuser switches it off for one statement)', () => {
    it('an edited row: verification fails that day, names the row, and leaves the other day passing', async () => {
      const victim = ids['d18']![1]!;
      await bypass(`UPDATE audit_logs SET action = 'nothing' WHERE id = '${victim}'::uuid`);
      const res = await chain.verify({ from: '2026-10-17', to: '2026-10-19' });
      expect(res.ok).toBe(false);
      const [d17, d18] = res.days;
      expect(d17).toMatchObject({ day: '2026-10-17', status: 'PASS', divergence: null });
      expect(d18).toMatchObject({
        day: '2026-10-18',
        status: 'FAIL',
        divergence: { rowId: victim, reason: 'MODIFIED' },
      });
      expect(d18!.actualChainHash).not.toBe(d18!.expectedChainHash);
      // The first row of that day, before the edit, still matches: the position is the edited row's.
      expect(d18!.divergence!.position).toBeGreaterThan(0);
      await bypass(`UPDATE audit_logs SET action = 'd18.b' WHERE id = '${victim}'::uuid`);
      expect((await chain.verify({ from: '2026-10-17', to: '2026-10-19' })).ok).toBe(true);
    });

    it('a deleted row is reported as missing, by id', async () => {
      const victim = ids['d17']![1]!;
      const [row] = await raw.auditLog.findMany({ where: { id: victim } });
      await bypass(`DELETE FROM audit_logs WHERE id = '${victim}'::uuid`);
      const res = await chain.verify({ from: '2026-10-17', to: '2026-10-17' });
      expect(res.days[0]).toMatchObject({
        status: 'FAIL',
        rows: 2,
        checkpointRows: 3,
        divergence: { rowId: victim, reason: 'MISSING' },
      });
      // Put it back exactly as it was.
      await raw.auditLog.create({ data: { ...row!, metadata: row!.metadata as object } });
      expect((await chain.verify({ from: '2026-10-17', to: '2026-10-19' })).ok).toBe(true);
    });

    it('a row slipped into a closed day (an ordinary INSERT, no bypass needed) is caught as unexpected', async () => {
      const extra = await insert('2026-10-18T07:00:00.000Z', 'late');
      const res = await chain.verify({ from: '2026-10-18', to: '2026-10-18' });
      expect(res.days[0]).toMatchObject({
        status: 'FAIL',
        rows: 5,
        checkpointRows: 4,
        divergence: { rowId: extra, reason: 'UNEXPECTED' },
      });
      await bypass(`DELETE FROM audit_logs WHERE id = '${extra}'::uuid`);
      expect((await chain.verify({ from: '2026-10-17', to: '2026-10-19' })).ok).toBe(true);
    });

    it('a rewritten checkpoint is caught too: the day fails, and so does the link to the next day', async () => {
      const [first] = await store.checkpointsBetween('2026-10-17', '2026-10-17');
      const forged = sha256('forged');
      await bypass(
        `UPDATE audit_chain_checkpoint SET "chainHash" = '${forged}' WHERE "chainDate" = '2026-10-17'`,
      );
      const res = await chain.verify({ from: '2026-10-17', to: '2026-10-19' });
      expect(res.ok).toBe(false);
      expect(res.days[0]).toMatchObject({
        day: '2026-10-17',
        status: 'FAIL',
        expectedChainHash: forged,
      });
      expect(res.days[1]).toMatchObject({
        day: '2026-10-18',
        status: 'FAIL',
        divergence: { reason: 'LINK_BROKEN' },
      });
      await bypass(
        `UPDATE audit_chain_checkpoint SET "chainHash" = '${first!.chainHash}' WHERE "chainDate" = '2026-10-17'`,
      );
      expect((await chain.verify({ from: '2026-10-17', to: '2026-10-19' })).ok).toBe(true);
    });

    it('a closed day with rows and no checkpoint is reported as unchecked, not as a pass', async () => {
      await insert('2026-10-19T05:00:00.000Z', 'forgotten-day');
      const res = await chain.verify({ from: '2026-10-17', to: '2026-10-19' });
      expect(res.ok).toBe(true);
      expect(res.uncheckedDays).toEqual(['2026-10-19']);
      expect((await chain.build()).built.map((b) => b.day)).toEqual(['2026-10-19']); // the next run catches up
      expect((await chain.verify({ from: '2026-10-17', to: '2026-10-19' })).uncheckedDays).toEqual(
        [],
      );
    });
  });
});

// ---- the route: an auditor verifies, nobody else does ---------------------------------------------------------------

describe.skipIf(!up)('GET /audit/chain/verify', () => {
  const raw = new PrismaClient({ datasourceUrl: dbUrl });
  const safe = createSafeClient(raw);
  let app: ReturnType<typeof createRealApp>['app'];
  const login = async (email: string) => {
    const agent = request.agent(app);
    const res = await agent.post('/auth/officer/login').send({ email, password: 'password123' });
    expect(res.status).toBe(200);
    return agent;
  };
  const day = (ago: number) => new Date(Date.now() - ago * 86_400_000);

  beforeAll(async () => {
    await raw.$executeRawUnsafe('TRUNCATE "audit_logs", "audit_chain_checkpoint", "users" CASCADE');
    const hash = await hashPassword('password123');
    for (const [email, role] of [
      ['auditor@example.com', 'AUDITOR'],
      ['officer@example.com', 'OFFICER'],
      ['lead@example.com', 'OFFICER_LEAD'],
    ] as const)
      await raw.user.create({ data: { email, role, passwordHash: hash } });

    app = createRealApp(raw).app;
    // Two closed days of history, then build.
    for (const [ago, n] of [
      [3, 3],
      [2, 2],
    ] as const)
      for (let i = 0; i < n; i++)
        await safe.auditLog.create({
          data: {
            actorType: 'SYSTEM',
            action: `history.${ago}.${i}`,
            entityType: 'Test',
            entityId: randomUUID(),
            metadata: {},
            createdAt: new Date(day(ago).setUTCHours(6, i, 0, 0)),
          },
        });
    await createAuditChainService({ store: createPrismaAuditChainStore(safe) }).build();
  });
  afterAll(async () => {
    await raw.$executeRawUnsafe('TRUNCATE "audit_logs", "audit_chain_checkpoint" CASCADE');
    await raw.$disconnect();
  });

  it('lets an auditor verify, and says pass for each chained day', async () => {
    const auditor = await login('auditor@example.com');
    const res = await auditor.get('/audit/chain/verify');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.days.length).toBeGreaterThanOrEqual(2);
    expect(res.body.days.every((d: { status: string }) => d.status === 'PASS')).toBe(true);
    const cps = await auditor.get('/audit/chain/checkpoints');
    expect(cps.body.last.chainDate).toBe(res.body.days.at(-1).day);
    expect(cps.headers['cache-control']).toBe('no-store');
  });

  it('is for people who hold audit.read: a lead yes, an officer no', async () => {
    expect((await (await login('lead@example.com')).get('/audit/chain/verify')).status).toBe(200);
    const denied = await (await login('officer@example.com')).get('/audit/chain/verify');
    expect(denied.status).toBe(403);
    expect(denied.body.error.details.permission).toBe('audit.read');
    expect((await request(app).get('/audit/chain/verify')).status).toBe(401);
  });

  it('validates its query and does not write to the audit log', async () => {
    const auditor = await login('auditor@example.com');
    expect((await auditor.get('/audit/chain/verify?from=nope')).status).toBe(400);
    expect((await auditor.get('/audit/chain/verify?from=2026-10-19&to=2026-10-01')).status).toBe(
      400,
    );
    const before = await raw.auditLog.count({ where: { action: { startsWith: 'audit.' } } });
    await auditor.get('/audit/chain/verify');
    expect(await raw.auditLog.count({ where: { action: { startsWith: 'audit.' } } })).toBe(before);
  });
});
