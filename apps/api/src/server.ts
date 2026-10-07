import { prisma as rawPrisma } from '@kyc-setu/db';
import { createSafeClient } from './db/safeClient.js';
import { createS3Client, ensureBucket } from '@kyc-setu/shared/storage';
import { createApp } from './app.js';
import { createHttpAiClient } from './modules/extraction/ai-client.js';
import { createPrismaExtractionStore } from './modules/extraction/store.js';
import { createPrismaOfficerStore } from './modules/officer/store.js';
import { createPrismaRiskStore } from './modules/risk/store.js';
import { createBullEnqueuer, createVerificationQueue } from './queue/verification.js';
import { assertBucketPrivate, createS3ObjectStore } from './modules/documents/object-store.js';
import { createPrismaDocumentStore } from './modules/documents/store.js';
import { loadEnv } from './config/env.js';
import { createPrismaKycStore } from './modules/kyc/store.js';
import { createPrismaAuthStore } from './modules/auth/store.js';
import { createRedis } from './queue/connection.js';
import { createHealthProbe } from './queue/health.js';
import { createSystemQueue } from './queue/queues.js';

// Everything the API and the worker do to the database goes through the safe client: no audit_logs update or delete.
const prisma = createSafeClient(rawPrisma);

const env = loadEnv(); // throws (and the process exits) on bad config

const s3 = createS3Client({
  endpoint: env.S3_ENDPOINT,
  region: env.S3_REGION,
  accessKeyId: env.S3_ACCESS_KEY,
  secretAccessKey: env.S3_SECRET_KEY,
});
const bucketState = await ensureBucket(s3, env.S3_BUCKET);
await assertBucketPrivate(s3, env.S3_BUCKET); // objects are reachable only through the API
console.log(`[api] bucket "${env.S3_BUCKET}" ${bucketState}, no public access`);

const redis = createRedis(env.REDIS_URL);
const queue = createSystemQueue(redis);
const verificationQueue = createVerificationQueue(redis, env.EXTRACTION_BACKOFF_SECONDS);
const app = createApp({
  env,
  store: createPrismaAuthStore(prisma),
  kycStore: createPrismaKycStore(prisma),
  documentStore: createPrismaDocumentStore(prisma),
  objectStore: createS3ObjectStore(s3, env.S3_BUCKET),
  extractionStore: createPrismaExtractionStore(prisma),
  riskStore: createPrismaRiskStore(prisma),
  officerStore: createPrismaOfficerStore(prisma),
  enqueuer: createBullEnqueuer(verificationQueue),
  aiClient: createHttpAiClient(env),
  healthProbe: createHealthProbe({ prisma, redis, queue }),
});

const server = app.listen(env.API_PORT, () =>
  console.log(`[api] listening on http://localhost:${env.API_PORT}`),
);

async function shutdown(signal: string): Promise<void> {
  console.log(`[api] ${signal} received, shutting down`);
  server.close();
  await queue.close();
  await verificationQueue.close();
  redis.disconnect();
  await prisma.$disconnect();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
