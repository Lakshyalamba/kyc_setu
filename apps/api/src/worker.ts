import { Worker } from 'bullmq';
import { prisma as rawPrisma } from '@kyc-setu/db';
import { createSafeClient } from './db/safeClient.js';
import { createS3Client } from '@kyc-setu/shared/storage';
import { loadEnv } from './config/env.js';
import { loggerFor } from './observability/logger.js';
import { initSentry } from './observability/sentry.js';
import { createPrismaAuthStore } from './modules/auth/store.js';
import { createS3ObjectStore } from './modules/documents/object-store.js';
import { createPrismaDocumentStore } from './modules/documents/store.js';
import { createHttpAiClient } from './modules/extraction/ai-client.js';
import { createPrismaExtractionStore } from './modules/extraction/store.js';
import { createPrismaAuditChainStore } from './modules/audit/chain.store.js';
import { createS3ExportBucket } from './modules/audit/export.bucket.js';
import { createPrismaAuditExportStore } from './modules/audit/export.store.js';
import { loadSigner } from './modules/audit/signing.js';
import { createPrismaOfficerStore } from './modules/officer/store.js';
import { createPrismaRiskStore } from './modules/risk/store.js';
import { createPrismaKycStore } from './modules/kyc/store.js';
import { createRedis } from './queue/connection.js';
import { processPing } from './queue/jobs/ping.js';
import { PING_JOB, SYSTEM_QUEUE, createSystemQueue } from './queue/queues.js';
import {
  createBullEnqueuer,
  createVerificationQueue,
  requeueStalePending,
} from './queue/verification.js';
import { createAuditEnqueuer, createAuditQueue, registerAuditSchedules } from './queue/audit.js';
import { buildServices } from './services.js';
import { createAuditWorker } from './workers/audit.js';
import { createVerificationWorker } from './workers/verification.js';

// Everything the API and the worker do to the database goes through the safe client: no audit_logs update or delete.
const prisma = createSafeClient(rawPrisma);

const env = loadEnv();
initSentry({ dsn: env.SENTRY_DSN, environment: env.NODE_ENV });
const log = loggerFor('worker');
const store = createPrismaAuthStore(prisma);
const connection = createRedis(env.REDIS_URL);

// --- system queue: the Phase 0 `ping` smoke test -------------------------------------------------
const worker = new Worker(
  SYSTEM_QUEUE,
  async (job) => {
    switch (job.name) {
      case PING_JOB:
        return processPing(job.data, { writeAudit: store.writeAudit });
      default:
        throw new Error(`Unknown job: ${job.name}`);
    }
  },
  { connection, concurrency: 5 },
);
worker.on('completed', (job) => log.info({ job: job.name, jobId: job.id }, 'job completed'));
worker.on('failed', (job, err) => log.error({ job: job?.name, jobId: job?.id, err }, 'job failed'));
log.info({ queue: SYSTEM_QUEUE }, 'listening');

// --- verification queue: OCR extraction ----------------------------------------------------------
const verificationQueue = createVerificationQueue(
  createRedis(env.REDIS_URL),
  env.EXTRACTION_BACKOFF_SECONDS,
);
const enqueuer = createBullEnqueuer(verificationQueue);
const extractionStore = createPrismaExtractionStore(prisma);
const s3 = createS3Client({
  endpoint: env.S3_ENDPOINT,
  region: env.S3_REGION,
  accessKeyId: env.S3_ACCESS_KEY,
  secretAccessKey: env.S3_SECRET_KEY,
});
const auditQueue = createAuditQueue(createRedis(env.REDIS_URL));
const { extraction, risk, notifier, auditChain, auditExport, retention } = buildServices({
  env,
  store,
  kycStore: createPrismaKycStore(prisma),
  documentStore: createPrismaDocumentStore(prisma),
  objectStore: createS3ObjectStore(s3, env.S3_BUCKET),
  extractionStore,
  riskStore: createPrismaRiskStore(prisma),
  officerStore: createPrismaOfficerStore(prisma),
  auditChainStore: createPrismaAuditChainStore(prisma),
  exports: {
    store: createPrismaAuditExportStore(prisma),
    bucket: createS3ExportBucket(s3, env.AUDIT_EXPORT_BUCKET),
    enqueuer: createAuditEnqueuer(auditQueue),
    signer: loadSigner({
      keyFile: env.AUDIT_SIGNING_KEY_FILE,
      production: env.NODE_ENV === 'production',
    }),
  },
  enqueuer,
  aiClient: createHttpAiClient(env),
});
const verificationWorker = createVerificationWorker({
  connection: createRedis(env.REDIS_URL),
  extraction,
  risk,
  notifier,
  backoffSeconds: env.EXTRACTION_BACKOFF_SECONDS,
  concurrency: 2,
});
log.info(
  { queue: 'verification', concurrency: 2, retryAfterSeconds: env.EXTRACTION_BACKOFF_SECONDS },
  'listening',
);

// --- audit queue: the nightly hash chain (00:05 IST) and signed session packets -------------------------
await registerAuditSchedules(auditQueue);
const auditWorker = createAuditWorker({
  connection: createRedis(env.REDIS_URL),
  chain: auditChain,
  exporter: auditExport,
  retention,
});
log.info({ queue: 'audit' }, 'listening (chain build at 00:05 IST, session packets)');

// Re-queue anything committed as PENDING whose job never reached Redis.
const requeued = await requeueStalePending(extractionStore, enqueuer);
if (requeued > 0) log.info({ requeued }, 're-queued stale pending extractions');

// Smoke test on boot so `pnpm dev` visibly proves the system queue works.
const queue = createSystemQueue(createRedis(env.REDIS_URL));
await queue.add(PING_JOB, { message: 'worker boot' });

async function shutdown(signal: string): Promise<void> {
  log.info({ signal }, 'shutting down');
  await Promise.all([worker.close(), verificationWorker.close(), auditWorker.close()]);
  await Promise.all([queue.close(), verificationQueue.close(), auditQueue.close()]);
  connection.disconnect();
  await prisma.$disconnect();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
