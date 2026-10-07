import type { PrismaClient } from '@kyc-setu/db';
import { createS3Client } from '@kyc-setu/shared/storage';
import { createApp, type AppDeps } from '../src/app.js';
import { createSafeClient } from '../src/db/safeClient.js';
import { createPrismaAuditChainStore } from '../src/modules/audit/chain.store.js';
import { createPrismaAuthStore } from '../src/modules/auth/store.js';
import { createS3ObjectStore } from '../src/modules/documents/object-store.js';
import { createPrismaDocumentStore } from '../src/modules/documents/store.js';
import { createPrismaExtractionStore } from '../src/modules/extraction/store.js';
import { createPrismaKycStore } from '../src/modules/kyc/store.js';
import { createPrismaOfficerStore } from '../src/modules/officer/store.js';
import { createPrismaRiskStore } from '../src/modules/risk/store.js';
import {
  createFakeAiClient,
  createFakeEnqueuer,
  createFakeExportDeps,
  testEnv,
} from './helpers.js';

/**
 * The whole API on the real database, with fakes only for the things that need a network (the AI service, the queue)
 * and an object store pointed at nothing, for tests that never touch a document.
 */
export function createRealApp(prisma: PrismaClient, overrides: Partial<AppDeps> = {}) {
  const safe = createSafeClient(prisma);
  const env = testEnv();
  const deps: AppDeps = {
    env,
    store: createPrismaAuthStore(safe),
    kycStore: createPrismaKycStore(safe),
    documentStore: createPrismaDocumentStore(safe),
    objectStore: createS3ObjectStore(
      createS3Client({
        endpoint: env.S3_ENDPOINT,
        region: 'us-east-1',
        accessKeyId: 'a',
        secretAccessKey: 'b',
      }),
      'unused',
    ),
    extractionStore: createPrismaExtractionStore(safe),
    riskStore: createPrismaRiskStore(safe),
    officerStore: createPrismaOfficerStore(safe),
    auditChainStore: createPrismaAuditChainStore(safe),
    exports: createFakeExportDeps([]),
    enqueuer: createFakeEnqueuer(),
    aiClient: createFakeAiClient(),
    healthProbe: async () => ({ database: 'up', redis: 'up', queue: null }),
    ...overrides,
  };
  return { app: createApp(deps), deps, safe };
}
