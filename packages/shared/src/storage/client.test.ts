import { describe, expect, it } from 'vitest';
import { createS3Client } from './client.js';

describe('createS3Client', () => {
  it('retries a failed attempt, so a stalled connection does not fail the request', async () => {
    const client = createS3Client({
      endpoint: 'http://localhost:9000',
      region: 'us-east-1',
      accessKeyId: 'k',
      secretAccessKey: 's',
    });
    expect(await client.config.maxAttempts()).toBe(4);
    client.destroy();
  });
});
