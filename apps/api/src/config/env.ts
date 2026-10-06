import { z } from 'zod';
import { parsePiiKey } from '@kyc-setu/shared/pii';
import { LocalKmsClient } from '@kyc-setu/shared/crypto';

const base64Key32 = (v: string) => {
  try {
    LocalKmsClient.fromBase64(v);
    return true;
  } catch {
    return false;
  }
};

export const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    API_PORT: z.coerce.number().int().positive().default(4000),
    DATABASE_URL: z.string().url(),
    REDIS_URL: z.string().url(),
    S3_ENDPOINT: z.string().url(),
    S3_REGION: z.string().min(1).default('us-east-1'),
    S3_ACCESS_KEY: z.string().min(1),
    S3_SECRET_KEY: z.string().min(1),
    S3_BUCKET: z.string().min(3).default('kyc-documents'),
    JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
    JWT_EXPIRES_IN_SECONDS: z.coerce.number().int().positive().default(86_400),
    PII_ENCRYPTION_KEY: z.string().refine((v) => {
      try {
        parsePiiKey(v);
        return true;
      } catch {
        return false;
      }
    }, 'PII_ENCRYPTION_KEY must be 32 random bytes, base64 encoded (openssl rand -base64 32)'),
    WEB_ORIGIN: z.string().url(),
    AI_SERVICE_URL: z.string().url(),
    /** Shared secret sent to the AI service as X-Internal-Key. */
    AI_INTERNAL_KEY: z.string().min(32, 'AI_INTERNAL_KEY must be at least 32 characters'),
    AI_REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(60_000),
    /** Seconds to wait before retry 1, 2 and 3 of a failed extraction (so 4 attempts in total). */
    EXTRACTION_BACKOFF_SECONDS: z
      .string()
      .default('10,60,300')
      .transform((v) => v.split(',').map((n) => Number(n.trim())))
      .refine(
        (a) => a.length >= 1 && a.every((n) => Number.isFinite(n) && n >= 0),
        'comma-separated seconds',
      ),
    /** How long raw OCR text is kept before the (not yet scheduled) sweeper may delete it. */
    OCR_RAW_TEXT_RETENTION_DAYS: z.coerce.number().int().positive().default(90),
    API_PUBLIC_URL: z.string().url().default('http://localhost:4000'),
    /** `local` wraps data keys with KMS_LOCAL_MASTER_KEY (dev only); `aws` is a stub for now. */
    KMS_PROVIDER: z.enum(['local', 'aws']).default('local'),
    KMS_LOCAL_MASTER_KEY: z.string().optional(),
    /** Signs the short-lived /files/<token> URLs. */
    FILE_URL_SECRET: z.string().min(32, 'FILE_URL_SECRET must be at least 32 characters'),
  })
  .superRefine((env, ctx) => {
    if (env.KMS_PROVIDER === 'local') {
      if (!env.KMS_LOCAL_MASTER_KEY || !base64Key32(env.KMS_LOCAL_MASTER_KEY)) {
        ctx.addIssue({
          code: 'custom',
          path: ['KMS_LOCAL_MASTER_KEY'],
          message: 'must be 32 random bytes, base64 encoded (openssl rand -base64 32)',
        });
      }
      if (env.NODE_ENV === 'production') {
        ctx.addIssue({
          code: 'custom',
          path: ['KMS_PROVIDER'],
          message: 'the local KMS is for development only; configure a real KMS in production',
        });
      }
    }
  });
export type Env = z.infer<typeof envSchema>;

/** Parses env and throws a readable error listing every problem. Call once at boot. */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    const lines = result.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid environment configuration:\n${lines.join('\n')}`);
  }
  return result.data;
}
