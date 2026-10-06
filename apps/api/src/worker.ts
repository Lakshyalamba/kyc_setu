import { Worker } from 'bullmq';
import { prisma } from '@kyc-setu/db';
import { loadEnv } from './config/env.js';
import { createPrismaAuthStore } from './modules/auth/store.js';
import { createRedis } from './queue/connection.js';
import { processPing } from './queue/jobs/ping.js';
import { PING_JOB, SYSTEM_QUEUE, createSystemQueue } from './queue/queues.js';

const env = loadEnv();
const store = createPrismaAuthStore(prisma);
const connection = createRedis(env.REDIS_URL);

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

// Smoke test on boot so `pnpm dev` visibly proves the queue works.
const queue = createSystemQueue(createRedis(env.REDIS_URL));
await queue.add(PING_JOB, { message: 'worker boot' });

async function shutdown(signal: string): Promise<void> {
  console.log(`[worker] ${signal} received, shutting down`);
  await worker.close();
  await queue.close();
  connection.disconnect();
  await prisma.$disconnect();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
