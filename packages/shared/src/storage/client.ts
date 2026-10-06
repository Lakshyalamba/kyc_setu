import { CreateBucketCommand, HeadBucketCommand, S3Client } from '@aws-sdk/client-s3';

export interface StorageConfig {
  endpoint: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
}

export function createS3Client(config: StorageConfig): S3Client {
  return new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
    forcePathStyle: true, // required for MinIO
  });
}

/** Idempotent: creates the bucket only if it does not exist. */
export async function ensureBucket(
  client: S3Client,
  bucket: string,
): Promise<'created' | 'exists'> {
  try {
    await client.send(new HeadBucketCommand({ Bucket: bucket }));
    return 'exists';
  } catch (err) {
    const status = (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
    if (status !== 404 && status !== 403 && (err as Error).name !== 'NotFound') throw err;
  }
  try {
    await client.send(new CreateBucketCommand({ Bucket: bucket }));
    return 'created';
  } catch (err) {
    const name = (err as Error).name;
    if (name === 'BucketAlreadyOwnedByYou' || name === 'BucketAlreadyExists') return 'exists';
    throw err;
  }
}
