import { GetObjectCommand, PutObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { PRESIGNED_GET_EXPIRY_SECONDS, PRESIGNED_PUT_EXPIRY_SECONDS } from '../constants.js';

export interface PresignedPutOptions {
  bucket: string;
  key: string;
  contentType: string;
  /** Seconds; defaults to 10 minutes. */
  expiresIn?: number;
}

export function getPresignedPutUrl(client: S3Client, opts: PresignedPutOptions): Promise<string> {
  return getSignedUrl(
    client,
    new PutObjectCommand({ Bucket: opts.bucket, Key: opts.key, ContentType: opts.contentType }),
    { expiresIn: opts.expiresIn ?? PRESIGNED_PUT_EXPIRY_SECONDS },
  );
}

export interface PresignedGetOptions {
  bucket: string;
  key: string;
  /** Seconds; defaults to 5 minutes. */
  expiresIn?: number;
  /**
   * The longest a link may last (default 5 minutes). Customer documents never go above that; the audit-export bucket,
   * whose files are for a person to download once, raises it to an hour.
   */
  maxExpiresIn?: number;
}

export function getPresignedGetUrl(client: S3Client, opts: PresignedGetOptions): Promise<string> {
  const expiresIn = Math.min(
    opts.expiresIn ?? PRESIGNED_GET_EXPIRY_SECONDS,
    opts.maxExpiresIn ?? PRESIGNED_GET_EXPIRY_SECONDS,
  );
  return getSignedUrl(client, new GetObjectCommand({ Bucket: opts.bucket, Key: opts.key }), {
    expiresIn,
  });
}
