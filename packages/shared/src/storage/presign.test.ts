import { describe, expect, it } from 'vitest';
import { createS3Client } from './client.js';
import { getPresignedGetUrl, getPresignedPutUrl } from './presign.js';

const client = createS3Client({
  endpoint: 'http://localhost:9000',
  region: 'us-east-1',
  accessKeyId: 'test',
  secretAccessKey: 'test',
});

describe('presigned URLs', () => {
  it('GET expires in 300s by default and is capped at 300s', async () => {
    const def = new URL(await getPresignedGetUrl(client, { bucket: 'b', key: 'k' }));
    expect(def.searchParams.get('X-Amz-Expires')).toBe('300');
    const capped = new URL(
      await getPresignedGetUrl(client, { bucket: 'b', key: 'k', expiresIn: 9999 }),
    );
    expect(capped.searchParams.get('X-Amz-Expires')).toBe('300');
    expect(def.pathname).toBe('/b/k');
  });

  it('PUT url is signed against the bucket/key', async () => {
    const url = new URL(
      await getPresignedPutUrl(client, {
        bucket: 'kyc-documents',
        key: 'a/b.png',
        contentType: 'image/png',
      }),
    );
    expect(url.pathname).toBe('/kyc-documents/a/b.png');
    expect(url.searchParams.get('X-Amz-Signature')).toBeTruthy();
  });
});
