import { z } from 'zod';
import { emailSchema } from './personal.js';

export const unlockRequestSchema = z.object({ email: emailSchema });
export const unlockResponseSchema = z.object({
  email: z.string(),
  unlockedAt: z.string().datetime(),
});

export const lockoutsResponseSchema = z.object({
  lockouts: z.array(
    z.object({
      email: z.string(),
      lockedAt: z.string().datetime(),
      lockedUntil: z.string().datetime(),
      failedAttempts: z.number().int(),
    }),
  ),
});
