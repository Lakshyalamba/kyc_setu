/** The AI service's health shape. The extraction contract is in ./extraction.ts, the face contract in ./face.ts. */
import { z } from 'zod';

export const aiHealthSchema = z.object({
  status: z.enum(['ok', 'loading', 'error']),
  service: z.literal('ai'),
  /** Per-model load state, e.g. { detector: 'loaded', en: 'loaded', hi: 'loaded' }. */
  models: z.record(z.string(), z.string()),
  versions: z.record(z.string(), z.string()),
});
