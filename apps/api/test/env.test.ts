import { describe, expect, it } from 'vitest';
import { loadEnv } from '../src/config/env.js';

const valid = {
  DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
  REDIS_URL: 'redis://localhost:6379',
  S3_ENDPOINT: 'http://localhost:9000',
  S3_ACCESS_KEY: 'a',
  S3_SECRET_KEY: 'b',
  JWT_SECRET: 'x'.repeat(32),
  KMS_LOCAL_MASTER_KEY: 'ZGV2LW9ubHkta21zLW1hc3Rlci1rZXktMDEyMzQ1Njc=',
  FILE_URL_SECRET: 'f'.repeat(32),
  PII_ENCRYPTION_KEY: 'ZGV2LW9ubHktcGlpLWtleS1jaGFuZ2UtbWUtMDEyMzQ=',
  WEB_ORIGIN: 'http://localhost:3000',
  AI_SERVICE_URL: 'http://localhost:8000',
};

describe('loadEnv', () => {
  it('parses a valid environment and applies defaults', () => {
    const env = loadEnv(valid);
    expect(env.API_PORT).toBe(4000);
    expect(env.S3_BUCKET).toBe('kyc-documents');
    expect(env.KMS_PROVIDER).toBe('local');
  });

  it('refuses the local KMS in production', () => {
    expect(() => loadEnv({ ...valid, NODE_ENV: 'production' })).toThrowError(
      /local KMS is for development only/,
    );
  });

  it('requires a valid KMS master key and file-url secret', () => {
    expect(() => loadEnv({ ...valid, KMS_LOCAL_MASTER_KEY: 'c2hvcnQ=' })).toThrowError(
      /KMS_LOCAL_MASTER_KEY/,
    );
    expect(() => loadEnv({ ...valid, FILE_URL_SECRET: 'short' })).toThrowError(/FILE_URL_SECRET/);
  });

  it('fails fast listing every missing / invalid variable', () => {
    expect(() => loadEnv({ JWT_SECRET: 'short' })).toThrowError(/DATABASE_URL[\s\S]*JWT_SECRET/);
  });
});
