import { z } from 'zod';
import type { AuthStore } from '../../modules/auth/store.js';

export const pingPayloadSchema = z.object({ message: z.string().default('ping') });
export interface PingResult {
  pong: true;
  message: string;
  processedAt: string;
}

/** Dummy job: proves enqueue -> worker -> DB write works end to end. */
export async function processPing(
  data: unknown,
  deps: { writeAudit: AuthStore['writeAudit'] },
): Promise<PingResult> {
  const { message } = pingPayloadSchema.parse(data);
  const processedAt = new Date().toISOString();
  await deps.writeAudit({
    actorId: null,
    actorType: 'SYSTEM',
    action: 'system.ping',
    entityType: 'Queue',
    entityId: 'system',
    metadata: { message },
  });
  return { pong: true, message, processedAt };
}
