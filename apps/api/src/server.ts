import { prisma as rawPrisma } from '@kyc-setu/db';
import { createSafeClient } from './db/safeClient.js';
import { createS3Client, ensureBucket } from '@kyc-setu/shared/storage';
import { createApp } from './app.js';
import { createHttpAiClient } from './modules/extraction/ai-client.js';
import { createPrismaExtractionStore } from './modules/extraction/store.js';
import { createPrismaAuditChainStore } from './modules/audit/chain.store.js';
import { createS3ExportBucket } from './modules/audit/export.bucket.js';
import { createPrismaAuditExportStore } from './modules/audit/export.store.js';
import { loadSigner } from './modules/audit/signing.js';
import { createAuditEnqueuer, createAuditQueue } from './queue/audit.js';
import { createPrismaOfficerStore } from './modules/officer/store.js';
import { createPrismaRiskStore } from './modules/risk/store.js';
import { createBullEnqueuer, createVerificationQueue } from './queue/verification.js';
import { assertBucketPrivate, createS3ObjectStore } from './modules/documents/object-store.js';
import { createPrismaDocumentStore } from './modules/documents/store.js';
import { redisStoreFactory } from './middleware/rateLimit.js';
import { loadEnv } from './config/env.js';
import { createPrismaKycStore } from './modules/kyc/store.js';
import { createPrismaAuthStore } from './modules/auth/store.js';
import { createRedis } from './queue/connection.js';
import { countQueues, createDependencyProbes, createHealthProbe } from './queue/health.js';
import { loggerFor } from './observability/logger.js';
import { initSentry } from './observability/sentry.js';
import { createSystemQueue } from './queue/queues.js';

// Everything the API and the worker do to the database goes through the safe client: no audit_logs update or delete.
const prisma = createSafeClient(rawPrisma);

const env = loadEnv(); // throws (and the process exits) on bad config
initSentry({ dsn: env.SENTRY_DSN, environment: env.NODE_ENV });
const log = loggerFor('api');

const s3 = createS3Client({
  endpoint: env.S3_ENDPOINT,
  region: env.S3_REGION,
  accessKeyId: env.S3_ACCESS_KEY,
  secretAccessKey: env.S3_SECRET_KEY,
});
const bucketState = await ensureBucket(s3, env.S3_BUCKET);
await assertBucketPrivate(s3, env.S3_BUCKET); // objects are reachable only through the API
log.info({ bucket: env.S3_BUCKET, state: bucketState }, 'bucket ready, no public access');

const exportsBucketState = await ensureBucket(s3, env.AUDIT_EXPORT_BUCKET);
await assertBucketPrivate(s3, env.AUDIT_EXPORT_BUCKET);
log.info(
  { bucket: env.AUDIT_EXPORT_BUCKET, state: exportsBucketState },
  'bucket ready, no public access',
);
const signer = loadSigner({
  keyFile: env.AUDIT_SIGNING_KEY_FILE,
  production: env.NODE_ENV === 'production',
});

const redis = createRedis(env.REDIS_URL);
const rateLimitsOn = env.RATE_LIMIT_ENABLED
  ? env.RATE_LIMIT_ENABLED === 'true'
  : env.NODE_ENV === 'production';
const queue = createSystemQueue(redis);
const verificationQueue = createVerificationQueue(redis, env.EXTRACTION_BACKOFF_SECONDS);
const auditQueue = createAuditQueue(redis);
const app = createApp({
  env,
  store: createPrismaAuthStore(prisma),
  kycStore: createPrismaKycStore(prisma),
  documentStore: createPrismaDocumentStore(prisma),
  objectStore: createS3ObjectStore(s3, env.S3_BUCKET),
  extractionStore: createPrismaExtractionStore(prisma),
  riskStore: createPrismaRiskStore(prisma),
  officerStore: createPrismaOfficerStore(prisma),
  auditChainStore: createPrismaAuditChainStore(prisma),
  exports: {
    store: createPrismaAuditExportStore(prisma),
    bucket: createS3ExportBucket(s3, env.AUDIT_EXPORT_BUCKET),
    enqueuer: createAuditEnqueuer(auditQueue),
    signer,
  },
  enqueuer: createBullEnqueuer(verificationQueue),
  aiClient: createHttpAiClient(env),
  healthProbe: createHealthProbe({ prisma, redis, queue }),
  dependencyProbes: createDependencyProbes({
    s3,
    buckets: [env.S3_BUCKET, env.AUDIT_EXPORT_BUCKET],
    aiUrl: env.AI_SERVICE_URL,
  }),
  queueDepth: () =>
    countQueues({ system: queue, verification: verificationQueue, audit: auditQueue }),
  rateLimit: {
    enabled: rateLimitsOn,
    // One count per limiter, in the same Redis the queues use: shared by every API instance, kept across restarts.
    makeStore: redisStoreFactory(redis),
  },
});
log.info(
  { enabled: rateLimitsOn },
  rateLimitsOn ? 'rate limits on' : 'rate limits off (set RATE_LIMIT_ENABLED=true to try them)',
);

const server = app.listen(env.API_PORT, () =>
  log.info({ port: env.API_PORT }, `listening on http://localhost:${env.API_PORT}`),
);

async function shutdown(signal: string): Promise<void> {
  log.info({ signal }, 'shutting down');
  server.close();
  await queue.close();
  await verificationQueue.close();
  await auditQueue.close();
  redis.disconnect();
  await prisma.$disconnect();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
