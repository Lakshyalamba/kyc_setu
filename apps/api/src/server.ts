import { prisma } from '@kyc-setu/db';
import { createS3Client, ensureBucket } from '@kyc-setu/shared/storage';
import { createApp } from './app.js';
import { loadEnv } from './config/env.js';
import { createPrismaAuthStore } from './modules/auth/store.js';
import { createRedis } from './queue/connection.js';
import { createHealthProbe } from './queue/health.js';
import { createSystemQueue } from './queue/queues.js';

const env = loadEnv(); // throws (and the process exits) on bad config

const s3 = createS3Client({
  endpoint: env.S3_ENDPOINT,
  region: env.S3_REGION,
  accessKeyId: env.S3_ACCESS_KEY,
  secretAccessKey: env.S3_SECRET_KEY,
});
const bucketState = await ensureBucket(s3, env.S3_BUCKET);
console.log(`[api] bucket "${env.S3_BUCKET}" ${bucketState}`);

const redis = createRedis(env.REDIS_URL);
const queue = createSystemQueue(redis);
const app = createApp({
  env,
  store: createPrismaAuthStore(prisma),
  healthProbe: createHealthProbe({ prisma, redis, queue }),
});

const server = app.listen(env.API_PORT, () =>
  console.log(`[api] listening on http://localhost:${env.API_PORT}`),
);

async function shutdown(signal: string): Promise<void> {
  console.log(`[api] ${signal} received, shutting down`);
  server.close();
  await queue.close();
  redis.disconnect();
  await prisma.$disconnect();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
