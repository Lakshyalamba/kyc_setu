import { z } from 'zod';

export const queueStatusSchema = z.object({
  waiting: z.number().int(),
  active: z.number().int(),
  delayed: z.number().int(),
  failed: z.number().int(),
  completed: z.number().int(),
});

export const healthResponseSchema = z.object({
  status: z.enum(['ok', 'degraded']),
  uptimeSeconds: z.number(),
  checks: z.object({
    database: z.enum(['up', 'down']),
    redis: z.enum(['up', 'down']),
    queue: queueStatusSchema.nullable(),
  }),
});
export type HealthResponse = z.infer<typeof healthResponseSchema>;
