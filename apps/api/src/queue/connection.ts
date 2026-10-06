import { Redis } from 'ioredis';

/** BullMQ requires maxRetriesPerRequest: null on its connections. */
export const createRedis = (url: string): Redis => new Redis(url, { maxRetriesPerRequest: null });
