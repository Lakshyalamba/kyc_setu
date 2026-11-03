import {
  okResponseSchema,
  selfieStatusResponseSchema,
  selfieUploadResponseSchema,
} from '@kyc-setu/shared';
import { apiFetch } from './api';

const meta = (form: FormData) => {
  form.append('screenWidth', String(Math.round(window.screen.width)));
  form.append('screenHeight', String(Math.round(window.screen.height)));
};

/** Browser-side calls for the selfie step. */
export const selfieClient = {
  status: (sessionId: string) =>
    apiFetch(`/kyc/sessions/${sessionId}/selfie/status`, { schema: selfieStatusResponseSchema }),

  /** Three frames and the best one (the middle one). */
  uploadFrames: (sessionId: string, frames: Blob[], best: Blob, retake: boolean) => {
    const form = new FormData();
    frames.forEach((f, i) => form.append(`frame${i}`, f, `frame${i}.jpg`));
    form.append('best', best, 'best.jpg');
    meta(form);
    return apiFetch(`/kyc/sessions/${sessionId}/selfie${retake ? '/retake' : ''}`, {
      method: 'POST',
      body: form,
      schema: selfieUploadResponseSchema,
    });
  },

  /** The file-upload fallback: one picture, no motion check (the application records that). */
  uploadFile: (sessionId: string, file: File, retake: boolean) => {
    const form = new FormData();
    form.append('file', file, file.name);
    meta(form);
    return apiFetch(`/kyc/sessions/${sessionId}/selfie${retake ? '/retake' : ''}`, {
      method: 'POST',
      body: form,
      schema: selfieUploadResponseSchema,
    });
  },

  /** Carry on with the selfie as it is, after a failed check, instead of retaking. */
  carryOn: (sessionId: string) =>
    apiFetch(`/kyc/sessions/${sessionId}/selfie/continue`, {
      method: 'POST',
      schema: okResponseSchema,
    }),
};
