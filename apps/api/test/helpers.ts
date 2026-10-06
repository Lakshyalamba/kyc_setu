import type { KycStatus } from '@kyc-setu/shared';
import {
  TERMINAL,
  type ConsentRecord,
  type KycStore,
  type OtpRecord,
  type SessionRecord,
} from '../src/modules/kyc/store.js';

import { randomUUID } from 'node:crypto';
import type { Env } from '../src/config/env.js';
import { hashPassword } from '../src/lib/password.js';
import type { AuditEntry, AuthStore, UserRecord } from '../src/modules/auth/store.js';
import type { Role } from '@kyc-setu/shared';

export const testEnv = (overrides: Partial<Env> = {}): Env => ({
  NODE_ENV: 'test',
  API_PORT: 4000,
  DATABASE_URL: 'postgresql://x:x@localhost:5432/x',
  REDIS_URL: 'redis://localhost:6379',
  S3_ENDPOINT: 'http://localhost:9000',
  S3_REGION: 'us-east-1',
  S3_ACCESS_KEY: 'a',
  S3_SECRET_KEY: 'b',
  S3_BUCKET: 'kyc-documents',
  JWT_SECRET: 'unit-test-secret-unit-test-secret-1234',
  JWT_EXPIRES_IN_SECONDS: 3600,
  PII_ENCRYPTION_KEY: 'ZGV2LW9ubHktcGlpLWtleS1jaGFuZ2UtbWUtMDEyMzQ=',
  API_PUBLIC_URL: 'http://localhost:4000',
  KMS_PROVIDER: 'local',
  KMS_LOCAL_MASTER_KEY: 'ZGV2LW9ubHkta21zLW1hc3Rlci1rZXktMDEyMzQ1Njc=',
  FILE_URL_SECRET: 'dev-only-file-url-secret-change-me-0123456789',
  WEB_ORIGIN: 'http://localhost:3000',
  AI_SERVICE_URL: 'http://localhost:8000',
  ...overrides,
});

export interface FakeStore extends AuthStore {
  users: UserRecord[];
  audits: AuditEntry[];
  addUser(email: string, password: string, role: Role): Promise<UserRecord>;
}

export function createFakeStore(): FakeStore {
  const users: UserRecord[] = [];
  const audits: AuditEntry[] = [];
  return {
    users,
    audits,
    async addUser(email, password, role) {
      const user = {
        id: randomUUID(),
        email,
        passwordHash: await hashPassword(password),
        role,
        createdAt: new Date(),
      };
      users.push(user);
      return user;
    },
    findUserByEmail: async (email) => users.find((u) => u.email === email) ?? null,
    findUserById: async (id) => users.find((u) => u.id === id) ?? null,
    async createCustomerWithAudit(input, audit) {
      if (users.some((u) => u.email === input.email)) return null;
      const user: UserRecord = {
        id: randomUUID(),
        ...input,
        role: 'CUSTOMER',
        createdAt: new Date(),
      };
      users.push(user);
      audits.push(audit(user));
      return user;
    },
    async writeAudit(entry) {
      audits.push(entry);
    },
  };
}

// ---- KYC fakes ----
export interface FakeKycStore extends KycStore {
  sessions: SessionRecord[];
  otps: OtpRecord[];
  consent: ConsentRecord;
}

/** In-memory KycStore. Audit rows go to the shared `audits` array (same one the auth fake uses). */
export function createFakeKycStore(audits: AuditEntry[]): FakeKycStore {
  const sessions: SessionRecord[] = [];
  const otps: OtpRecord[] = [];
  const consent: ConsentRecord = {
    id: randomUUID(),
    version: '1.0.0',
    bodyMarkdown: '# Consent\n\nTest text.',
    effectiveFrom: new Date('2026-01-01T00:00:00Z'),
  };
  const need = <T>(v: T | undefined): T => {
    if (v === undefined) throw new Error('not found');
    return v;
  };
  return {
    sessions,
    otps,
    consent,
    findActiveSession: async (userId) =>
      sessions.find((s) => s.userId === userId && !TERMINAL.includes(s.status)) ?? null,
    findSession: async (id) => sessions.find((s) => s.id === id) ?? null,
    async createSession(input, audit) {
      if (sessions.some((s) => s.userId === input.userId && !TERMINAL.includes(s.status)))
        return null;
      const s: SessionRecord = {
        id: randomUUID(),
        userId: input.userId,
        status: 'DRAFT',
        currentStep: 'CONTACT',
        completedSteps: [],
        personalDetails: null,
        consentVersionId: null,
        consentAcceptedAt: null,
        createdAt: new Date(),
        expiresAt: input.expiresAt,
      };
      sessions.push(s);
      audits.push(audit(s));
      return s;
    },
    async updateSession(id, expected: KycStatus, patch, newAudits, markOtpVerified) {
      const s = sessions.find((x) => x.id === id);
      if (!s || s.status !== expected) return null;
      Object.assign(s, patch);
      if (markOtpVerified)
        need(otps.find((o) => o.id === markOtpVerified.id)).verifiedAt = markOtpVerified.at;
      audits.push(...newAudits);
      return s;
    },
    latestConsent: async () => consent,
    countOtpSends: async (userId, since) =>
      otps.filter((o) => o.userId === userId && o.createdAt >= since).length,
    async createOtpChallenge({ challenge, personalDetails, now, audit }) {
      for (const o of otps) {
        if (o.sessionId === challenge.sessionId && !o.verifiedAt && o.expiresAt > now)
          o.expiresAt = now;
      }
      const created: OtpRecord = {
        ...challenge,
        id: randomUUID(),
        attempts: 0,
        verifiedAt: null,
        createdAt: now,
      };
      otps.push(created);
      need(sessions.find((s) => s.id === challenge.sessionId)).personalDetails = personalDetails;
      audits.push(audit(created));
      return created;
    },
    findLatestOtp: async (sessionId) =>
      otps.filter((o) => o.sessionId === sessionId).at(-1) ?? null,
    async incrementOtpAttempts(id) {
      const o = need(otps.find((x) => x.id === id));
      o.attempts += 1;
      return { ...o };
    },
    async invalidateOtp(id, now) {
      need(otps.find((x) => x.id === id)).expiresAt = now;
    },
    async writeAudit(entry) {
      audits.push(entry);
    },
  };
}

// ---- Document fakes ----
import { Readable } from 'node:stream';
import type { ObjectStore } from '../src/modules/documents/object-store.js';
import type {
  DocumentRecord,
  DocumentStore,
  SignedUrlIssueRecord,
} from '../src/modules/documents/store.js';

export interface FakeObjectStore extends ObjectStore {
  objects: Map<string, Buffer>;
}

export function createFakeObjectStore(): FakeObjectStore {
  const objects = new Map<string, Buffer>();
  return {
    objects,
    async put(key, body) {
      const chunks: Buffer[] = [];
      for await (const c of body) chunks.push(c as Buffer);
      objects.set(key, Buffer.concat(chunks));
    },
    async get(key) {
      const o = objects.get(key);
      if (!o) throw new Error('NoSuchKey');
      return Readable.from([o]);
    },
    async remove(key) {
      objects.delete(key);
    },
  };
}

export interface FakeDocumentStore extends DocumentStore {
  documents: DocumentRecord[];
  issues: SignedUrlIssueRecord[];
}

export function createFakeDocumentStore(audits: AuditEntry[]): FakeDocumentStore {
  const documents: DocumentRecord[] = [];
  const issues: SignedUrlIssueRecord[] = [];
  return {
    documents,
    issues,
    listActive: async (sessionId) =>
      documents.filter((d) => d.sessionId === sessionId && d.replacedById === null),
    findById: async (id) => documents.find((d) => d.id === id) ?? null,
    async insertReplacing(doc, buildAudits) {
      const existing = documents.find(
        (d) => d.sessionId === doc.sessionId && d.type === doc.type && d.replacedById === null,
      );
      if (existing) existing.replacedById = doc.id;
      const document: DocumentRecord = { ...doc, uploadedAt: new Date(), replacedById: null };
      documents.push(document);
      audits.push(...buildAudits(existing ?? null));
      return { document, replaced: existing ?? null };
    },
    async softDelete(id, audit) {
      const d = documents.find((x) => x.id === id);
      if (!d || d.replacedById !== null) return false;
      d.replacedById = id;
      audits.push(audit);
      return true;
    },
    async createSignedUrlIssue(input, audit) {
      const issue: SignedUrlIssueRecord = { ...input, id: randomUUID(), issuedAt: new Date() };
      issues.push(issue);
      audits.push(audit(issue));
      return issue;
    },
    findIssue: async (id) => issues.find((i) => i.id === id) ?? null,
    async writeAudit(entry) {
      audits.push(entry);
    },
  };
}

/** The document-related deps every `createApp` call needs. */
export const docDeps = (audits: AuditEntry[]) => ({
  documentStore: createFakeDocumentStore(audits),
  objectStore: createFakeObjectStore(),
});
