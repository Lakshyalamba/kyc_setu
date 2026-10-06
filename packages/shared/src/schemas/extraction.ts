/**
 * Contract between the Node worker and services/ai (`POST /extract/pan|aadhaar`).
 * The pydantic mirror is services/ai/app/schemas.py. Both are validated against the JSON samples in
 * /contracts, so a change on either side that breaks the other fails a test.
 */
import { z } from 'zod';
import { extractionStatusSchema } from './common.js';

export const EXTRACTION_DOCUMENT_TYPES = ['PAN', 'AADHAAR_FRONT', 'AADHAAR_BACK'] as const;
export const extractionDocumentTypeSchema = z.enum(EXTRACTION_DOCUMENT_TYPES);
export type ExtractionDocumentType = z.infer<typeof extractionDocumentTypeSchema>;

export const AI_RESULT_STATUSES = ['ok', 'low_quality', 'parse_failed', 'wrong_document'] as const;
export const aiResultStatusSchema = z.enum(AI_RESULT_STATUSES);
export type AiResultStatus = z.infer<typeof aiResultStatusSchema>;

/** Normalised (0..1) box on the *deskewed* image, not the original. */
export const bboxSchema = z.object({
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  w: z.number().min(0).max(1),
  h: z.number().min(0).max(1),
});

export const extractedFieldSchema = z.object({
  value: z.string(),
  confidence: z.number().min(0).max(1),
  bbox: bboxSchema,
});
export type ExtractedField = z.infer<typeof extractedFieldSchema>;

export const extractedFieldsSchema = z.object({
  name: extractedFieldSchema.optional(),
  fatherName: extractedFieldSchema.optional(), // PAN
  dob: extractedFieldSchema.optional(), // ISO date
  panNumber: extractedFieldSchema.optional(), // PAN
  aadhaarNumber: extractedFieldSchema.optional(), // AADHAAR_FRONT, always masked: XXXX-XXXX-1234
  gender: extractedFieldSchema.optional(), // AADHAAR_FRONT: MALE | FEMALE | OTHER
  address: extractedFieldSchema.optional(), // AADHAAR_BACK
  pincode: extractedFieldSchema.optional(), // AADHAAR_BACK
});
export type ExtractedFields = z.infer<typeof extractedFieldsSchema>;

export const qualitySchema = z.object({
  /** Variance of the Laplacian on a width-normalised grayscale image. Below 50 is rejected. */
  sharpness: z.number(),
  /** Mean grayscale value, 0..255. */
  brightness: z.number(),
  resolution: z.object({ w: z.number().int(), h: z.number().int() }),
  deskewAngle: z.number(),
  /** e.g. "LOW_SHARPNESS (31.2 < 50)". */
  warnings: z.array(z.string()),
});

export const extractResponseSchema = z.object({
  documentId: z.string().uuid(),
  documentType: extractionDocumentTypeSchema,
  status: aiResultStatusSchema,
  quality: qualitySchema,
  fields: extractedFieldsSchema,
  /** Full OCR text. Contains the full Aadhaar number, so the worker must encrypt it immediately. */
  rawText: z.string(),
  modelVersions: z.object({
    ocr: z.string(),
    ocrModels: z.string(),
    preprocessor: z.string(),
  }),
  timings: z.object({
    fetchMs: z.number(),
    preprocessMs: z.number(),
    ocrMs: z.number(),
    parseMs: z.number(),
    totalMs: z.number(),
  }),
});
export type ExtractResponse = z.infer<typeof extractResponseSchema>;

export const extractPanRequestSchema = z.object({
  documentId: z.string().uuid(),
  signedUrl: z.string().url(),
  sessionId: z.string().uuid(),
});
export const extractAadhaarRequestSchema = extractPanRequestSchema.extend({
  documentType: z.enum(['AADHAAR_FRONT', 'AADHAAR_BACK']),
});
export type ExtractPanRequest = z.infer<typeof extractPanRequestSchema>;
export type ExtractAadhaarRequest = z.infer<typeof extractAadhaarRequestSchema>;

// ---- What customers may see (never the extracted values) ----

export const extractionSummaryDtoSchema = z.object({
  documentId: z.string().uuid(),
  type: z.enum(['PAN', 'AADHAAR_FRONT', 'AADHAAR_BACK', 'SIGNATURE']),
  status: extractionStatusSchema,
  completedAt: z.string().datetime().nullable(),
});
export type ExtractionSummaryDto = z.infer<typeof extractionSummaryDtoSchema>;

export const extractionListResponseSchema = z.object({
  extractions: z.array(extractionSummaryDtoSchema),
});
export const extractionResponseSchema = z.object({ extraction: extractionSummaryDtoSchema });
