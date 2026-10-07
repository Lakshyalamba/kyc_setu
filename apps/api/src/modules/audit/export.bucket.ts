import { PutObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import { AUDIT_EXPORT_URL_TTL_SECONDS } from '@kyc-setu/shared';
import { getPresignedGetUrl } from '@kyc-setu/shared/storage';

/** The private bucket the finished packets live in, apart from customer documents. */
export interface ExportBucket {
  put(key: string, data: Uint8Array, contentType: string): Promise<void>;
  /** A link that works for `expiresInSeconds` (the caller passes one hour). */
  signedGetUrl(key: string, expiresInSeconds: number): Promise<string>;
}

export function createS3ExportBucket(client: S3Client, bucket: string): ExportBucket {
  return {
    async put(key, data, contentType) {
      await client.send(
        new PutObjectCommand({ Bucket: bucket, Key: key, Body: data, ContentType: contentType }),
      );
    },
    signedGetUrl: (key, expiresInSeconds) =>
      getPresignedGetUrl(client, {
        bucket,
        key,
        expiresIn: expiresInSeconds,
        maxExpiresIn: AUDIT_EXPORT_URL_TTL_SECONDS,
      }),
  };
}
