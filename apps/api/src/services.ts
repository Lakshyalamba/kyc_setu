import { AwsKmsClient, LocalKmsClient, type KmsClient } from '@kyc-setu/shared/crypto';
import { parsePiiKey } from '@kyc-setu/shared/pii';
import type { Env } from './config/env.js';
import { createAuditChainService, type AuditChainService } from './modules/audit/chain.service.js';
import type { AuditChainStore } from './modules/audit/chain.store.js';
import type { AuthStore } from './modules/auth/store.js';
import {
  createDocumentsService,
  type DocumentsService,
} from './modules/documents/documents.service.js';
import type { ObjectStore } from './modules/documents/object-store.js';
import type { DocumentStore } from './modules/documents/store.js';
import type { AiClient } from './modules/extraction/ai-client.js';
import {
  createExtractionService,
  type ExtractionService,
} from './modules/extraction/extraction.service.js';
import type { ExtractionStore } from './modules/extraction/store.js';
import {
  createKycService,
  type KycService,
  type KycServiceDeps,
} from './modules/kyc/kyc.service.js';
import type { KycStore } from './modules/kyc/store.js';
import {
  createCustomerStatusService,
  type CustomerStatusService,
} from './modules/officer/customer-status.js';
import { createNotificationService, type NotificationService } from './modules/officer/notify.js';
import { createOfficerService, type OfficerService } from './modules/officer/officer.service.js';
import type { OfficerStore } from './modules/officer/store.js';
import { createRiskService, type RiskService } from './modules/risk/risk.service.js';
import type { RiskStore } from './modules/risk/store.js';
import type { VerificationEnqueuer } from './queue/verification.js';

export interface ServiceDeps {
  env: Env;
  /** Auth store (users, audit). */
  store: AuthStore;
  kycStore: KycStore;
  documentStore: DocumentStore;
  objectStore: ObjectStore;
  extractionStore: ExtractionStore;
  riskStore: RiskStore;
  officerStore: OfficerStore;
  auditChainStore: AuditChainStore;
  /** Queues extraction jobs when documents are submitted. */
  enqueuer: VerificationEnqueuer;
  aiClient: AiClient;
  /** Defaults to the provider configured in env. */
  kms?: KmsClient;
  /** Test seams (clock, OTP generator). */
  kycOverrides?: Partial<Pick<KycServiceDeps, 'now' | 'generateOtp'>>;
}

export interface Services {
  kyc: KycService;
  docs: DocumentsService;
  extraction: ExtractionService;
  risk: RiskService;
  officer: OfficerService;
  notifier: NotificationService;
  customerStatus: CustomerStatusService;
  auditChain: AuditChainService;
  kms: KmsClient;
}

/** The service graph shared by the HTTP app and the queue worker. */
export function buildServices(deps: ServiceDeps): Services {
  const { env } = deps;
  const piiKey = parsePiiKey(env.PII_ENCRYPTION_KEY);
  const kms =
    deps.kms ??
    (env.KMS_PROVIDER === 'local'
      ? LocalKmsClient.fromBase64(env.KMS_LOCAL_MASTER_KEY ?? '')
      : new AwsKmsClient());

  const kyc = createKycService({ env, store: deps.kycStore, piiKey, ...deps.kycOverrides });
  // `docs` and `extraction` need each other once (a resubmission nudges the extraction pipeline after a submit),
  // so the link is made lazily.
  const later: { advance?: (sessionId: string) => Promise<void> } = {};
  const docs = createDocumentsService({
    env,
    kyc,
    kycStore: deps.kycStore,
    store: deps.documentStore,
    objects: deps.objectStore,
    kms,
    enqueuer: deps.enqueuer,
    afterSubmit: (sessionId) => later.advance?.(sessionId) ?? Promise.resolve(),
    ...deps.kycOverrides,
  });
  const risk = createRiskService({
    env,
    store: deps.riskStore,
    kycStore: deps.kycStore,
    extractionStore: deps.extractionStore,
    decisions: deps.officerStore,
    enqueuer: deps.enqueuer,
    kms,
    piiKey,
    ...deps.kycOverrides,
  });
  const extraction = createExtractionService({
    env,
    store: deps.extractionStore,
    documents: docs,
    documentStore: deps.documentStore,
    kycStore: deps.kycStore,
    kyc,
    auth: deps.store,
    ai: deps.aiClient,
    kms,
    piiKey,
    onDocsExtracted: async (sessionId) => {
      await risk.resumeAfterResubmission(sessionId);
    },
    ...deps.kycOverrides,
  });
  later.advance = (sessionId) => extraction.advanceIfReady(sessionId);
  const officer = createOfficerService({
    env,
    store: deps.officerStore,
    kycStore: deps.kycStore,
    documentStore: deps.documentStore,
    extractionStore: deps.extractionStore,
    riskStore: deps.riskStore,
    docs,
    enqueuer: deps.enqueuer,
    kms,
    piiKey,
    ...deps.kycOverrides,
  });
  const notifier = createNotificationService({
    store: deps.officerStore,
    kycStore: deps.kycStore,
    auth: deps.store,
  });
  const customerStatus = createCustomerStatusService({
    kycStore: deps.kycStore,
    store: deps.officerStore,
    auth: deps.store,
  });
  const auditChain = createAuditChainService({ store: deps.auditChainStore, ...deps.kycOverrides });
  return { kyc, docs, extraction, risk, officer, notifier, customerStatus, auditChain, kms };
}
