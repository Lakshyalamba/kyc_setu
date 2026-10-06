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
  AI_INTERNAL_KEY: 'test-internal-key-0123456789abcdef',
  AI_REQUEST_TIMEOUT_MS: 5000,
  EXTRACTION_BACKOFF_SECONDS: [0, 0, 0],
  OCR_RAW_TEXT_RETENTION_DAYS: 90,
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
  /** Extraction rows requested by updateSession (the fake extraction store reads these). */
  extractionSeeds: { documentId: string; status: 'PENDING' | 'SKIPPED' }[];
  sessions: SessionRecord[];
  otps: OtpRecord[];
  consent: ConsentRecord;
}

/** In-memory KycStore. Audit rows go to the shared `audits` array (same one the auth fake uses). */
export function createFakeKycStore(audits: AuditEntry[]): FakeKycStore {
  const sessions: SessionRecord[] = [];
  const extractionSeeds: { documentId: string; status: 'PENDING' | 'SKIPPED' }[] = [];
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
    extractionSeeds,
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
        flags: [],
        consentVersionId: null,
        consentAcceptedAt: null,
        createdAt: new Date(),
        expiresAt: input.expiresAt,
      };
      sessions.push(s);
      audits.push(audit(s));
      return s;
    },
    async updateSession(id, expected: KycStatus, patch, newAudits, markOtpVerified, extractions) {
      const s = sessions.find((x) => x.id === id);
      if (!s || s.status !== expected) return null;
      Object.assign(s, patch);
      if (markOtpVerified)
        need(otps.find((o) => o.id === markOtpVerified.id)).verifiedAt = markOtpVerified.at;
      for (const e of extractions ?? []) extractionSeeds.push(e);
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

// ---- Extraction fakes ----
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { ExtractResponse, ExtractionDocumentType } from '@kyc-setu/shared';
import {
  AiServiceError,
  type AiClient,
  type ExtractRequest,
} from '../src/modules/extraction/ai-client.js';
import type {
  ExtractionRecord,
  ExtractionStore,
  ExtractionWithType,
} from '../src/modules/extraction/store.js';
import type { VerificationEnqueuer } from '../src/queue/verification.js';

export interface FakeExtractionStore extends ExtractionStore {
  rows: Map<string, ExtractionRecord>;
}

export function createFakeExtractionStore(
  audits: AuditEntry[],
  kycStore: FakeKycStore,
  docStore: FakeDocumentStore,
): FakeExtractionStore {
  const rows = new Map<string, ExtractionRecord>();
  /** Rows the fake KycStore was asked to create inside its "transaction". */
  const sync = () => {
    for (const seed of kycStore.extractionSeeds) {
      if (rows.has(seed.documentId)) continue;
      rows.set(seed.documentId, {
        id: randomUUID(),
        documentId: seed.documentId,
        status: seed.status,
        fields: null,
        qualityMetrics: null,
        modelVersions: null,
        timings: null,
        rawTextEncrypted: null,
        encryptedDataKey: null,
        kmsKeyId: null,
        iv: null,
        authTag: null,
        panNumberHmac: null,
        aadhaarNumberLast4: null,
        attempt: 0,
        errorMessage: null,
        createdAt: new Date(Date.now() - 60_000),
        completedAt: seed.status === 'SKIPPED' ? new Date() : null,
      });
    }
  };
  const need = (documentId: string) => {
    sync();
    const row = rows.get(documentId);
    if (!row) throw new Error('no extraction row');
    return row;
  };
  return {
    /** Always in sync with what the fake KycStore "inserted". */
    get rows() {
      sync();
      return rows;
    },
    async findByDocumentId(documentId) {
      sync();
      return rows.get(documentId) ?? null;
    },
    async listForSession(sessionId) {
      sync();
      const out: ExtractionWithType[] = [];
      for (const d of docStore.documents) {
        const row = rows.get(d.id);
        if (d.sessionId === sessionId && d.replacedById === null && row)
          out.push({ ...row, documentType: d.type });
      }
      return out;
    },
    async recordAttemptFailure(documentId, attempt, message, audit) {
      Object.assign(need(documentId), { attempt, errorMessage: message });
      audits.push(audit);
    },
    async complete(documentId, input, audit) {
      const row = need(documentId);
      if (row.status !== 'PENDING' && row.status !== 'ERROR') return null;
      Object.assign(row, {
        status: input.status,
        fields: input.fields,
        qualityMetrics: input.qualityMetrics,
        modelVersions: input.modelVersions,
        timings: input.timings,
        rawTextEncrypted: input.raw?.ciphertext ?? null,
        encryptedDataKey: input.raw?.wrappedKey ?? null,
        iv: input.raw?.iv ?? null,
        authTag: input.raw?.authTag ?? null,
        kmsKeyId: input.raw?.kmsKeyId ?? null,
        panNumberHmac: input.panNumberHmac,
        aadhaarNumberLast4: input.aadhaarNumberLast4,
        attempt: input.attempt,
        errorMessage: null,
        completedAt: new Date(),
      });
      audits.push(audit);
      return row;
    },
    async fail(documentId, attempt, message, audit) {
      const row = need(documentId);
      if (row.status === 'PENDING' || row.status === 'ERROR') {
        Object.assign(row, {
          status: 'ERROR',
          attempt,
          errorMessage: message,
          completedAt: new Date(),
        });
      }
      audits.push(audit);
    },
    async findStalePending(olderThan) {
      sync();
      return [...rows.values()]
        .filter((r) => r.status === 'PENDING' && r.createdAt < olderThan)
        .map((r) => r.documentId);
    },
    async clearRawTextBefore(before) {
      sync();
      let n = 0;
      for (const r of rows.values()) {
        if (r.completedAt && r.completedAt < before && r.rawTextEncrypted) {
          Object.assign(r, {
            rawTextEncrypted: null,
            encryptedDataKey: null,
            iv: null,
            authTag: null,
            kmsKeyId: null,
          });
          n++;
        }
      }
      return n;
    },
    async writeAudit(entry) {
      audits.push(entry);
    },
  };
}

export interface FakeEnqueuer extends VerificationEnqueuer {
  queued: string[];
  failNext: boolean;
}

export function createFakeEnqueuer(): FakeEnqueuer {
  const e: FakeEnqueuer = {
    queued: [],
    failNext: false,
    async enqueueExtractions(ids) {
      if (e.failNext) {
        e.failNext = false;
        throw new Error('redis is down');
      }
      e.queued.push(...ids);
    },
  };
  return e;
}

const CONTRACTS = path.resolve(import.meta.dirname, '../../../contracts');
const SAMPLE_FILE: Record<ExtractionDocumentType, string> = {
  PAN: 'extract-pan.ok.json',
  AADHAAR_FRONT: 'extract-aadhaar-front.ok.json',
  AADHAAR_BACK: 'extract-aadhaar-back.ok.json',
};

/** A contract-valid AI response for `type`, from the shared /contracts samples. */
export function aiResponse(
  type: ExtractionDocumentType,
  documentId: string,
  overrides: Partial<ExtractResponse> = {},
): ExtractResponse {
  const sample = JSON.parse(
    readFileSync(path.join(CONTRACTS, SAMPLE_FILE[type]), 'utf8'),
  ) as ExtractResponse;
  return { ...sample, documentId, ...overrides };
}

export interface FakeAiClient extends AiClient {
  calls: ExtractRequest[];
  /** Decide each response. Default: a good result for the requested document. */
  respond: (req: ExtractRequest) => ExtractResponse | Promise<ExtractResponse>;
}

export function createFakeAiClient(): FakeAiClient {
  const client: FakeAiClient = {
    calls: [],
    respond: (req) => aiResponse(req.type, req.documentId),
    async extract(req) {
      client.calls.push(req);
      return client.respond(req);
    },
  };
  return client;
}

export const unreachableAi = () => new AiServiceError('AI service unreachable (TypeError)', true);

/** Everything `createApp`/`buildServices` needs beyond env, auth store and kyc store. */
export function allDeps(audits: AuditEntry[], kycStore: FakeKycStore) {
  const documentStore = createFakeDocumentStore(audits);
  const extractionStore = createFakeExtractionStore(audits, kycStore, documentStore);
  const objectStore = createFakeObjectStore();
  const enqueuer = createFakeEnqueuer();
  const aiClient = createFakeAiClient();
  return { documentStore, extractionStore, objectStore, enqueuer, aiClient };
}
