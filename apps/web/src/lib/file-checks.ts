import { ALLOWED_DOCUMENT_MIME, MAX_DOCUMENT_BYTES, type DocumentType } from '@kyc-setu/shared';

/**
 * Smallest image we'll accept. For identity documents this matches the OCR service's own gate
 * (min side 400 px), so we don't upload files that are certain to be rejected as low quality.
 */
export const MIN_IMAGE_SIDE: Record<DocumentType, number> = {
  PAN: 400,
  AADHAAR_FRONT: 400,
  AADHAAR_BACK: 400,
  SIGNATURE: 40,
};
export const MAX_IMAGE_SIDE = 10_000;

const mb = (n: number) => `${Math.round(n / 1024 / 1024)} MB`;

/** Cheap, synchronous checks. The server re-checks everything (it never trusts the browser). */
export function checkFileBasics(
  file: { size: number; type: string },
  type: DocumentType,
): string | null {
  if (file.size === 0) return 'That file is empty.';
  if (file.size > MAX_DOCUMENT_BYTES) {
    return `That file is too large. The limit is ${mb(MAX_DOCUMENT_BYTES)}.`;
  }
  const allowed: readonly string[] = ALLOWED_DOCUMENT_MIME[type];
  if (!allowed.includes(file.type)) {
    const names = allowed.map((m) =>
      m.replace('image/', '').replace('application/', '').toUpperCase(),
    );
    return `Please choose a ${names.join(', ')} file.`;
  }
  return null;
}

export function checkDimensions(width: number, height: number, type: DocumentType): string | null {
  const min = MIN_IMAGE_SIDE[type];
  if (width < min || height < min)
    return 'That image is too small to read. Please use a clearer photo.';
  if (width > MAX_IMAGE_SIDE || height > MAX_IMAGE_SIDE)
    return 'That image is too large. Please use a smaller photo.';
  return null;
}

/** Decodes an image in the browser to read its dimensions. PDFs are skipped. */
export async function checkImage(file: Blob, type: DocumentType): Promise<string | null> {
  if (file.type === 'application/pdf') return null;
  try {
    const bitmap = await createImageBitmap(file);
    const error = checkDimensions(bitmap.width, bitmap.height, type);
    bitmap.close();
    return error;
  } catch {
    return "We couldn't read that image. Please try another file.";
  }
}
