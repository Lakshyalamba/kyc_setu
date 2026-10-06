import { z } from 'zod';
import { parsePiiKey } from '@kyc-setu/shared/pii';

export const envSchema = z.object({
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
