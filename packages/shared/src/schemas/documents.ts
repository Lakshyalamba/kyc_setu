import { z } from 'zod';
import { documentTypeSchema, signedUrlPurposeSchema } from './common.js';

export const documentDtoSchema = z.object({
  id: z.string().uuid(),
  type: documentTypeSchema,
  mimeType: z.string(),
  sizeBytes: z.number().int(),
  /** SHA-256 of the plaintext file, hex. */
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  uploadedAt: z.string().datetime(),
});
export type DocumentDto = z.infer<typeof documentDtoSchema>;

export const documentListResponseSchema = z.object({ documents: z.array(documentDtoSchema) });

export const documentUploadResponseSchema = documentDtoSchema
  .pick({
    type: true,
    sha256: true,
    uploadedAt: true,
  })
  .extend({ documentId: z.string().uuid() });
export type DocumentUploadResponse = z.infer<typeof documentUploadResponseSchema>;

export const documentParamsSchema = z.object({ docId: z.string().uuid() });
export const sessionDocumentParamsSchema = z.object({
  id: z.string().uuid(),
  docId: z.string().uuid(),
});

export const signedUrlQuerySchema = z.object({
  purpose: signedUrlPurposeSchema.default('CUSTOMER_PREVIEW'),
});

export const signedUrlResponseSchema = z.object({
  url: z.string().url(),
  expiresAt: z.string().datetime(),
  purpose: signedUrlPurposeSchema,
});
export type SignedUrlResponse = z.infer<typeof signedUrlResponseSchema>;

/** Opaque, URL-safe token (see apps/api signed-token.ts). Carries no document id. */
export const fileTokenParamsSchema = z.object({
  token: z.string().regex(/^[A-Za-z0-9_-]{60,120}$/),
});
