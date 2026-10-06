/** `/match` contract (stub). The extraction contract lives in ./extraction.ts. */
import { z } from 'zod';

const matchField = z.object({ value: z.string(), confidence: z.number().min(0).max(1) });
const nameAndDob = z.object({ fullName: matchField, dateOfBirth: matchField });

/** Still a stub in the AI service; real cross-document matching arrives in a later phase. */
export const matchRequestSchema = z.object({ pan: nameAndDob, aadhaar: nameAndDob });
export type MatchRequest = z.infer<typeof matchRequestSchema>;

export const matchResponseSchema = z.object({
  nameSimilarity: z.number().min(0).max(1),
  dobMatch: z.boolean(),
  verdict: z.enum(['MATCH', 'REVIEW', 'MISMATCH']),
  reasons: z.array(z.string()),
});
export type MatchResponse = z.infer<typeof matchResponseSchema>;

export const aiHealthSchema = z.object({
  status: z.enum(['ok', 'loading', 'error']),
  service: z.literal('ai'),
  /** Per-model load state, e.g. { detector: 'loaded', en: 'loaded', hi: 'loaded' }. */
  models: z.record(z.string(), z.string()),
  versions: z.record(z.string(), z.string()),
});
