import {
  documentListResponseSchema,
  documentUploadResponseSchema,
  kycSessionResponseSchema,
  okResponseSchema,
  signedUrlResponseSchema,
  type DocumentType,
} from '@kyc-setu/shared';
import { apiFetch } from './api';

export const documentsClient = {
  list: (sessionId: string) =>
    apiFetch(`/kyc/sessions/${sessionId}/documents`, { schema: documentListResponseSchema }),

  /** Multipart upload through the API (the browser never talks to object storage). */
  upload: (sessionId: string, type: DocumentType, file: Blob, filename: string) => {
    const form = new FormData();
    form.append('type', type); // must come before the file part
    form.append('file', file, filename);
    return apiFetch(`/kyc/sessions/${sessionId}/documents`, {
      method: 'POST',
      body: form,
      schema: documentUploadResponseSchema,
    });
  },

  remove: (sessionId: string, docId: string) =>
    apiFetch(`/kyc/sessions/${sessionId}/documents/${docId}`, {
      method: 'DELETE',
      schema: okResponseSchema,
    }),

  signedUrl: (docId: string) =>
    apiFetch(`/kyc/documents/${docId}/signed-url?purpose=CUSTOMER_PREVIEW`, {
      schema: signedUrlResponseSchema,
    }),

  submit: (sessionId: string) =>
    apiFetch(`/kyc/sessions/${sessionId}/documents/submit`, {
      method: 'POST',
      schema: kycSessionResponseSchema,
    }),
};
