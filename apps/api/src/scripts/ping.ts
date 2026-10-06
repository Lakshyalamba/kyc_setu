// Usage: pnpm --filter @kyc-setu/api ping   (requires the worker to be running)
import { QueueEvents } from 'bullmq';
import { loadEnv } from '../config/env.js';
import { createRedis } from '../queue/connection.js';
import { PING_JOB, SYSTEM_QUEUE, createSystemQueue } from '../queue/queues.js';

const env = loadEnv();
const connection = createRedis(env.REDIS_URL);
const queue = createSystemQueue(connection);
const events = new QueueEvents(SYSTEM_QUEUE, { connection: createRedis(env.REDIS_URL) });

const job = await queue.add(PING_JOB, { message: 'manual ping' });
const result: unknown = await job.waitUntilFinished(events, 10_000);
console.log('ping result:', result);

await events.close();
await queue.close();
connection.disconnect();
