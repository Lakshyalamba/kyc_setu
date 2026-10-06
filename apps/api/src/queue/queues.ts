import { Queue } from 'bullmq';
import type { Redis } from 'ioredis';

export const SYSTEM_QUEUE = 'system';
export const PING_JOB = 'ping';

export const createSystemQueue = (connection: Redis, name = SYSTEM_QUEUE): Queue =>
  new Queue(name, {
    connection,
    defaultJobOptions: { removeOnComplete: { count: 100 }, removeOnFail: { count: 100 } },
  });
