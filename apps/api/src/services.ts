import { AwsKmsClient, LocalKmsClient, type KmsClient } from '@kyc-setu/shared/crypto';
import { parsePiiKey } from '@kyc-setu/shared/pii';
import type { Env } from './config/env.js';
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
import type { VerificationEnqueuer } from './queue/verification.js';

export interface ServiceDeps {
  env: Env;
  /** Auth store (users, audit). */
  store: AuthStore;
  kycStore: KycStore;
  documentStore: DocumentStore;
  objectStore: ObjectStore;
  extractionStore: ExtractionStore;
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
  const docs = createDocumentsService({
    env,
    kyc,
    kycStore: deps.kycStore,
    store: deps.documentStore,
    objects: deps.objectStore,
    kms,
    enqueuer: deps.enqueuer,
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
    ...deps.kycOverrides,
  });
  return { kyc, docs, extraction, kms };
}
