// Real Postgres. A published consent text is what a customer agreed to: it can be replaced, never edited.
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient } from '@kyc-setu/db';
import { createSafeClient } from '../src/db/safeClient.js';
import { hashPassword } from '../src/lib/password.js';
import {
  compareVersions,
  createConsentService,
  sha256Hex,
} from '../src/modules/consent/consent.service.js';
import { createPrismaConsentStore } from '../src/modules/consent/consent.store.js';
import { snippetOf } from '../src/modules/officer/officer.service.js';
import { createRealApp } from './realApp.js';

describe('versions and snippets', () => {
  it('compares semantic versions numerically, not as text', () => {
    expect(compareVersions('1.10.0', '1.9.0')).toBe(1);
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0);
    expect(compareVersions('0.9.9', '1.0.0')).toBe(-1);
    expect(() => compareVersions('1.0', '1.0.0')).toThrow(/not a version/);
  });
  it('shortens a consent text to its first words, without markdown noise', () => {
    expect(snippetOf('# Consent\n\nI agree to **share** my details.')).toBe(
      'Consent I agree to share my details.',
    );
    const long = 'word '.repeat(100);
    const out = snippetOf(long, 50);
    expect(out.length).toBeLessThanOrEqual(51);
    expect(out.endsWith('…')).toBe(true);
    expect(out).not.toMatch(/wor…$/);
  });
});

const up = process.env['INFRA_UP'] === '1';
const dbUrl = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL'] ?? '';
const V1 =
  '# Consent v1\n\nI agree that KYC Setu may verify my identity with the documents I upload.';
const V2 =
  '# Consent v2\n\nI agree that KYC Setu may verify my identity, and keep the result for seven years.';

describe.skipIf(!up)('consent versions on Postgres', () => {
  const raw = new PrismaClient({ datasourceUrl: dbUrl });
  const safe = createSafeClient(raw);
  const NOW = new Date('2026-10-20T10:00:00Z');
  const service = createConsentService({ store: createPrismaConsentStore(safe), now: () => NOW });
  let v1: string;

  beforeEach(async () => {
    await raw.$executeRawUnsafe(
      'TRUNCATE "audit_logs", "kyc_sessions", "users", "consent_versions" CASCADE',
    );
    v1 = (
      await raw.consentVersion.create({
        data: {
          version: '1.0.0',
          bodyMarkdown: V1,
          effectiveFrom: new Date('2026-01-01T00:00:00Z'),
        },
      })
    ).id;
  });
  afterAll(async () => {
    await raw.$executeRawUnsafe(
      'TRUNCATE "audit_logs", "kyc_sessions", "users", "consent_versions" CASCADE',
    );
    await raw.$disconnect();
  });

  describe('the table', () => {
    it('refuses to change the text, the version or the effective date of a published consent', async () => {
      for (const set of [
        `"bodyMarkdown" = 'edited'`,
        `version = '9.9.9'`,
        `"effectiveFrom" = now()`,
        `"createdAt" = now()`,
      ]) {
        await expect(
          raw.$executeRawUnsafe(`UPDATE consent_versions SET ${set} WHERE id = '${v1}'::uuid`),
          set,
        ).rejects.toThrow(/immutable/);
      }
      expect((await raw.consentVersion.findUniqueOrThrow({ where: { id: v1 } })).bodyMarkdown).toBe(
        V1,
      );
    });

    it('refuses a delete', async () => {
      await expect(
        raw.$executeRawUnsafe(`DELETE FROM consent_versions WHERE id = '${v1}'::uuid`),
      ).rejects.toThrow(/immutable/);
      await expect(raw.consentVersion.delete({ where: { id: v1 } })).rejects.toThrow(/immutable/);
    });

    it('lets supersededAt be set once, and nothing else about it change afterwards', async () => {
      await raw.consentVersion.update({ where: { id: v1 }, data: { supersededAt: NOW } });
      expect(
        (await raw.consentVersion.findUniqueOrThrow({ where: { id: v1 } })).supersededAt,
      ).toEqual(NOW);
      await expect(
        raw.consentVersion.update({ where: { id: v1 }, data: { supersededAt: new Date() } }),
      ).rejects.toThrow(/set once/);
      await expect(
        raw.consentVersion.update({ where: { id: v1 }, data: { supersededAt: null } }),
      ).rejects.toThrow(/set once/);
    });

    it('still accepts new rows', async () => {
      const row = await raw.consentVersion.create({
        data: { version: '1.1.0', bodyMarkdown: V2, effectiveFrom: new Date() },
      });
      expect(row.supersededAt).toBeNull();
    });
  });

  describe('the revision flow', () => {
    it('writes the new version and supersedes the old one in the same moment', async () => {
      const { created, superseded } = await service.revise({ version: '1.1.0', bodyMarkdown: V2 });
      expect(created).toMatchObject({ version: '1.1.0', bodyMarkdown: V2, supersededAt: null });
      expect(created.effectiveFrom).toEqual(NOW);
      expect(superseded).toMatchObject({ id: v1, version: '1.0.0', supersededAt: NOW });
      // The old text is untouched.
      expect((await raw.consentVersion.findUniqueOrThrow({ where: { id: v1 } })).bodyMarkdown).toBe(
        V1,
      );
      expect((await service.current())?.version).toBe('1.1.0');

      const audit = await raw.auditLog.findFirstOrThrow({ where: { action: 'consent.revised' } });
      expect(audit).toMatchObject({
        entityType: 'ConsentVersion',
        entityId: created.id,
        actorId: null,
        metadata: {
          version: '1.1.0',
          previousVersion: '1.0.0',
          supersededId: v1,
          sha256: sha256Hex(V2),
        },
      });
      expect(JSON.stringify(audit)).not.toContain('keep the result'); // the text is on the row, not in the log
    });

    it('wants a higher version, a well-formed one, and some text', async () => {
      await expect(service.revise({ version: '1.0.0', bodyMarkdown: V2 })).rejects.toMatchObject({
        status: 409,
        code: 'VERSION_NOT_HIGHER',
      });
      await expect(service.revise({ version: '0.9.0', bodyMarkdown: V2 })).rejects.toMatchObject({
        status: 409,
      });
      await expect(service.revise({ version: '2', bodyMarkdown: V2 })).rejects.toMatchObject({
        status: 400,
      });
      await expect(service.revise({ version: '1.2.0', bodyMarkdown: ' ' })).rejects.toMatchObject({
        status: 400,
      });
      expect(await raw.consentVersion.count()).toBe(1);
      expect(
        (await raw.consentVersion.findUniqueOrThrow({ where: { id: v1 } })).supersededAt,
      ).toBeNull();
    });

    it('is all or nothing: if anything after the insert fails, the old version is not superseded and the new one is not there', async () => {
      const store = createPrismaConsentStore(safe);
      await expect(
        store.revise({ version: '1.1.0', bodyMarkdown: V2, effectiveFrom: NOW, now: NOW }, () => {
          throw new Error('audit builder failed');
        }),
      ).rejects.toThrow('audit builder failed');
      expect(await raw.consentVersion.count()).toBe(1);
      expect(
        (await raw.consentVersion.findUniqueOrThrow({ where: { id: v1 } })).supersededAt,
      ).toBeNull();
      expect(await raw.auditLog.count({ where: { action: 'consent.revised' } })).toBe(0);
    });

    it('answers a duplicate version with a clear error and changes nothing', async () => {
      await raw.consentVersion.create({
        data: {
          version: '1.2.0',
          bodyMarkdown: V2,
          effectiveFrom: new Date('2026-01-02T00:00:00Z'),
          supersededAt: NOW,
        },
      });
      const store = createPrismaConsentStore(safe);
      expect(
        await store.revise(
          { version: '1.2.0', bodyMarkdown: V2, effectiveFrom: NOW, now: NOW },
          () => ({
            actorId: null,
            actorType: 'SYSTEM',
            action: 'x',
            entityType: 'x',
            entityId: 'x',
          }),
        ),
      ).toBe('DUPLICATE_VERSION');
      expect(
        (await raw.consentVersion.findUniqueOrThrow({ where: { id: v1 } })).supersededAt,
      ).toBeNull();
    });

    it('does not let a future-dated version become current early, or the superseded one linger', async () => {
      await service.revise({
        version: '1.1.0',
        bodyMarkdown: V2,
        effectiveFrom: new Date('2026-12-01T00:00:00Z'),
      });
      // v1.0.0 is superseded at once, but v1.1.0 is not in force until December: nothing is "current" in between.
      expect(await service.current()).toBeNull();
    });
  });

  describe('through the API', () => {
    const PASSWORD = 'password123';
    let app: ReturnType<typeof createRealApp>['app'];
    let sessionId: string;

    beforeEach(async () => {
      app = createRealApp(raw).app;
      const hash = await hashPassword(PASSWORD);
      const customer = await raw.user.create({
        data: { email: 'c@example.com', passwordHash: hash },
      });
      await raw.user.create({
        data: { email: 'o@example.com', role: 'OFFICER', passwordHash: hash },
      });
      await raw.user.create({
        data: { email: 'a@example.com', role: 'AUDITOR', passwordHash: hash },
      });
      // A customer who accepted version 1.
      sessionId = (
        await raw.kycSession.create({
          data: {
            userId: customer.id,
            status: 'UNDER_REVIEW',
            currentStep: 'REVIEW',
            expiresAt: new Date(Date.now() + 86_400_000),
            consentVersionId: v1,
            consentAcceptedAt: new Date('2026-10-05T09:00:00Z'),
            personalDetails: { fullName: 'Rahul Kumar Sharma' },
          },
        })
      ).id;
    });

    const login = async (email: string, realm: 'officer' | 'customer') => {
      const agent = request.agent(app);
      expect(
        (await agent.post(`/auth/${realm}/login`).send({ email, password: PASSWORD })).status,
      ).toBe(200);
      return agent;
    };

    it('/kyc/consent/current returns the newest version that is not superseded', async () => {
      const customer = await login('c@example.com', 'customer');
      expect((await customer.get('/kyc/consent/current')).body.consent).toMatchObject({
        id: v1,
        version: '1.0.0',
      });
      const { created } = await service.revise({
        version: '1.1.0',
        bodyMarkdown: V2,
        effectiveFrom: new Date(Date.now() - 1000),
      });
      const now = await customer.get('/kyc/consent/current');
      expect(now.body.consent).toMatchObject({
        id: created.id,
        version: '1.1.0',
        bodyMarkdown: V2,
      });
    });

    it('a customer who loaded the old text is told to read the new one before accepting', async () => {
      const hash = await hashPassword(PASSWORD);
      const fresh = await raw.user.create({
        data: { email: 'fresh@example.com', passwordHash: hash },
      });
      const draft = await raw.kycSession.create({
        data: {
          userId: fresh.id,
          status: 'DRAFT',
          currentStep: 'CONSENT',
          completedSteps: ['CONTACT'],
          expiresAt: new Date(Date.now() + 86_400_000),
        },
      });
      const customer = await login('fresh@example.com', 'customer');
      await service.revise({
        version: '1.1.0',
        bodyMarkdown: V2,
        effectiveFrom: new Date(Date.now() - 1000),
      });
      const stale = await customer
        .post(`/kyc/sessions/${draft.id}/consent`)
        .send({ versionId: v1, accepted: true });
      expect(stale.status).toBe(409);
      expect(stale.body.error.code).toBe('CONSENT_VERSION_STALE');
      const current = (await customer.get('/kyc/consent/current')).body.consent;
      const ok = await customer
        .post(`/kyc/sessions/${draft.id}/consent`)
        .send({ versionId: current.id, accepted: true });
      expect(ok.status).toBe(200);
      const saved = await raw.kycSession.findUniqueOrThrow({
        where: { id: draft.id },
        include: { consentVersion: true },
      });
      expect(saved.consentVersion?.version).toBe('1.1.0');
      expect(saved.consentVersion?.bodyMarkdown).toBe(V2);
    });

    it('a session keeps pointing at the text its customer saw, after any number of revisions', async () => {
      await service.revise({
        version: '1.1.0',
        bodyMarkdown: V2,
        effectiveFrom: new Date(Date.now() - 2000),
      });
      await service.revise({ version: '1.2.0', bodyMarkdown: `${V2}\n\nAnd one more thing.` });
      const session = await raw.kycSession.findUniqueOrThrow({
        where: { id: sessionId },
        include: { consentVersion: true },
      });
      expect(session.consentVersion?.bodyMarkdown).toBe(V1);
      expect(session.consentVersion?.version).toBe('1.0.0');
      expect(session.consentVersion?.supersededAt).not.toBeNull();
    });

    it('the review page shows the version, when it was accepted, a snippet and the exact archived text', async () => {
      await service.revise({
        version: '1.1.0',
        bodyMarkdown: V2,
        effectiveFrom: new Date(Date.now() - 1000),
      });
      const officer = await login('o@example.com', 'officer');
      const res = await officer.get(`/officer/sessions/${sessionId}`);
      expect(res.status).toBe(200);
      expect(res.body.session.consent).toEqual({
        versionId: v1,
        version: '1.0.0',
        acceptedAt: '2026-10-05T09:00:00.000Z',
        effectiveFrom: '2026-01-01T00:00:00.000Z',
        supersededAt: expect.any(String),
        snippet:
          'Consent v1 I agree that KYC Setu may verify my identity with the documents I upload.',
        sha256: sha256Hex(V1),
        textSnapshot: V1,
      });
      // An auditor sees the very same archived text.
      const auditor = await login('a@example.com', 'officer');
      expect(
        (await auditor.get(`/officer/sessions/${sessionId}`)).body.session.consent.textSnapshot,
      ).toBe(V1);
    });
  });
});
