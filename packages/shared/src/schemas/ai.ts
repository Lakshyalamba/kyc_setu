/**
 * Contracts between apps/api and services/ai. The Python stubs in services/ai/app/schemas.py
 * mirror these shapes; keep the two in sync.
 */
import { z } from 'zod';

/** A single extracted value plus the model's confidence (0..1). */
const field = <T extends z.ZodTypeAny>(value: T) =>
  z.object({ value, confidence: z.number().min(0).max(1) });

export const extractRequestSchema = z.object({
  /** Object key inside the kyc-documents bucket. */
  objectKey: z.string().min(1),
});
export type ExtractRequest = z.infer<typeof extractRequestSchema>;

export const panExtractionSchema = z.object({
  documentType: z.literal('PAN'),
  fields: z.object({
    panNumber: field(z.string().regex(/^[A-Z]{5}[0-9]{4}[A-Z]$/)),
    fullName: field(z.string()),
    fatherName: field(z.string()),
    dateOfBirth: field(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)),
  }),
  overallConfidence: z.number().min(0).max(1),
});
export type PanExtraction = z.infer<typeof panExtractionSchema>;

export const aadhaarExtractionSchema = z.object({
  documentType: z.literal('AADHAAR'),
  fields: z.object({
    /** Only the last 4 digits are ever returned/stored. */
    aadhaarLast4: field(z.string().regex(/^\d{4}$/)),
    fullName: field(z.string()),
    dateOfBirth: field(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)),
    gender: field(z.enum(['M', 'F', 'O'])),
    address: field(z.string()),
    pincode: field(z.string().regex(/^\d{6}$/)),
  }),
  overallConfidence: z.number().min(0).max(1),
});
export type AadhaarExtraction = z.infer<typeof aadhaarExtractionSchema>;

export const matchRequestSchema = z.object({
  pan: panExtractionSchema.shape.fields.pick({ fullName: true, dateOfBirth: true }),
  aadhaar: aadhaarExtractionSchema.shape.fields.pick({ fullName: true, dateOfBirth: true }),
});
export type MatchRequest = z.infer<typeof matchRequestSchema>;

export const matchResponseSchema = z.object({
  nameSimilarity: z.number().min(0).max(1),
  dobMatch: z.boolean(),
  verdict: z.enum(['MATCH', 'REVIEW', 'MISMATCH']),
  reasons: z.array(z.string()),
});
export type MatchResponse = z.infer<typeof matchResponseSchema>;

export const aiHealthSchema = z.object({ status: z.literal('ok'), service: z.literal('ai') });
