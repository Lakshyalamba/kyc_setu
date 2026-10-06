import type { ExtractionStore } from './store.js';

/**
 * Deletes encrypted raw OCR text older than the retention period. Implemented and tested, but NOT
 * scheduled anywhere yet: wiring it to a cron/repeatable job is a later (hardening) step.
 */
export async function sweepExpiredRawText(
  store: Pick<ExtractionStore, 'clearRawTextBefore'>,
  retentionDays: number,
  now: Date = new Date(),
): Promise<number> {
  const cutoff = new Date(now.getTime() - retentionDays * 86_400_000);
  return store.clearRawTextBefore(cutoff);
}
