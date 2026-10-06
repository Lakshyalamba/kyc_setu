import { Worker } from 'bullmq';
import { prisma } from '@kyc-setu/db';
import { createS3Client } from '@kyc-setu/shared/storage';
import { loadEnv } from './config/env.js';
import { createPrismaAuthStore } from './modules/auth/store.js';
import { createS3ObjectStore } from './modules/documents/object-store.js';
import { createPrismaDocumentStore } from './modules/documents/store.js';
import { createHttpAiClient } from './modules/extraction/ai-client.js';
import { createPrismaExtractionStore } from './modules/extraction/store.js';
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
import { buildServices } from './services.js';
import { createVerificationWorker } from './workers/verification.js';

const env = loadEnv();
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
worker.on('completed', (job) => console.log(`[worker] ${job.name}#${job.id} completed`));
worker.on('failed', (job, err) => console.error(`[worker] ${job?.name}#${job?.id} failed:`, err));
console.log(`[worker] listening on queue "${SYSTEM_QUEUE}"`);

// --- verification queue: OCR extraction ----------------------------------------------------------
const verificationQueue = createVerificationQueue(
  createRedis(env.REDIS_URL),
  env.EXTRACTION_BACKOFF_SECONDS,
);
const enqueuer = createBullEnqueuer(verificationQueue);
const extractionStore = createPrismaExtractionStore(prisma);
const { extraction, risk } = buildServices({
  env,
  store,
  kycStore: createPrismaKycStore(prisma),
  documentStore: createPrismaDocumentStore(prisma),
  objectStore: createS3ObjectStore(
    createS3Client({
      endpoint: env.S3_ENDPOINT,
      region: env.S3_REGION,
      accessKeyId: env.S3_ACCESS_KEY,
      secretAccessKey: env.S3_SECRET_KEY,
    }),
    env.S3_BUCKET,
  ),
  extractionStore,
  riskStore: createPrismaRiskStore(prisma),
  enqueuer,
  aiClient: createHttpAiClient(env),
});
const verificationWorker = createVerificationWorker({
  connection: createRedis(env.REDIS_URL),
  extraction,
  risk,
  backoffSeconds: env.EXTRACTION_BACKOFF_SECONDS,
  concurrency: 2,
});
console.log(
  `[worker] listening on queue "verification" (concurrency 2, retries after ${env.EXTRACTION_BACKOFF_SECONDS.join('s, ')}s)`,
);

// Re-queue anything committed as PENDING whose job never reached Redis.
const requeued = await requeueStalePending(extractionStore, enqueuer);
if (requeued > 0) console.log(`[worker] re-queued ${requeued} stale pending extraction(s)`);

// Smoke test on boot so `pnpm dev` visibly proves the system queue works.
const queue = createSystemQueue(createRedis(env.REDIS_URL));
await queue.add(PING_JOB, { message: 'worker boot' });

async function shutdown(signal: string): Promise<void> {
  console.log(`[worker] ${signal} received, shutting down`);
  await Promise.all([worker.close(), verificationWorker.close()]);
  await Promise.all([queue.close(), verificationQueue.close()]);
  connection.disconnect();
  await prisma.$disconnect();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
