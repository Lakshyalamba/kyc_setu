import {
  DeleteObjectCommand,
  GetBucketPolicyCommand,
  GetObjectCommand,
  type S3Client,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import type { Readable } from 'node:stream';

/** Where ciphertext lives. S3/MinIO in production, an in-memory fake in unit tests. */
export interface ObjectStore {
  /** Streams `body` (length unknown up front) to `key`. */
  put(key: string, body: Readable, contentType: string): Promise<void>;
  get(key: string): Promise<Readable>;
  remove(key: string): Promise<void>;
}

export function createS3ObjectStore(client: S3Client, bucket: string): ObjectStore {
  return {
    async put(key, body, contentType) {
      // lib-storage streams unknown-length bodies; anything under one 5 MB part is a single PutObject.
      const upload = new Upload({
        client,
        params: { Bucket: bucket, Key: key, Body: body, ContentType: contentType },
        queueSize: 1,
      });
      await upload.done();
    },
    async get(key) {
      const res = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      return res.Body as Readable; // a Node stream when running under Node
    },
    async remove(key) {
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    },
  };
}

interface PolicyStatement {
  Effect?: string;
  Principal?: unknown;
}

const isAnonymous = (principal: unknown): boolean => {
  if (principal === '*') return true;
  if (principal && typeof principal === 'object') {
    const aws = (principal as { AWS?: unknown }).AWS;
    return aws === '*' || (Array.isArray(aws) && aws.includes('*'));
  }
  return false;
};

/**
 * Boot-time guard: objects are only ever reachable through the API, so the bucket must have no
 * policy that grants anonymous access. (No policy at all = private, which is what we want.)
 */
export async function assertBucketPrivate(client: S3Client, bucket: string): Promise<void> {
  let raw: string | undefined;
  try {
    raw = (await client.send(new GetBucketPolicyCommand({ Bucket: bucket }))).Policy;
  } catch (err) {
    const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
    if (e.name === 'NoSuchBucketPolicy' || e.$metadata?.httpStatusCode === 404) return;
    throw err;
  }
  if (!raw) return;
  const statements = (JSON.parse(raw) as { Statement?: PolicyStatement[] }).Statement ?? [];
  if (statements.some((s) => s.Effect === 'Allow' && isAnonymous(s.Principal))) {
    throw new Error(`Bucket "${bucket}" has a policy allowing anonymous access; refusing to start`);
  }
}
