import { z } from 'zod';

export const queueStatusSchema = z.object({
  waiting: z.number().int(),
  active: z.number().int(),
  delayed: z.number().int(),
  failed: z.number().int(),
  completed: z.number().int(),
});

/** Liveness: the process is up and answering. Touches nothing else, so a load balancer can call it freely. */
export const livenessResponseSchema = z.object({
  status: z.literal('ok'),
  uptimeSeconds: z.number(),
});
export type LivenessResponse = z.infer<typeof livenessResponseSchema>;

const upDown = z.enum(['up', 'down']);

/** Readiness: every dependency this service needs to do its job answered within the budget. */
export const readyResponseSchema = z.object({
  status: z.enum(['ok', 'degraded']),
  uptimeSeconds: z.number(),
  checks: z.object({
    database: upDown,
    redis: upDown,
    /** Object storage (MinIO / S3). Absent when the caller wired no probe, which only tests do. */
    storage: upDown.optional(),
    /** The FastAPI extraction service, which must answer its own /readyz. */
    ai: upDown.optional(),
    queue: queueStatusSchema.nullable(),
  }),
});
export type ReadyResponse = z.infer<typeof readyResponseSchema>;

/** The shape probes hand back. */
export type HealthResponse = ReadyResponse;
export const healthResponseSchema = readyResponseSchema;
