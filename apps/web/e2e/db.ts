import path from 'node:path';
import { PrismaClient } from '@kyc-setu/db';

// The e2e tests assert on what the stack actually wrote, so they read the same database directly.
try {
  process.loadEnvFile(path.resolve(__dirname, '../../../.env'));
} catch {
  /* in CI the variables come from the job environment */
}

export const prisma = new PrismaClient();

export const API_URL = 'http://localhost:4000';
export const S3_URL = process.env['S3_ENDPOINT'] ?? 'http://localhost:9000';
export const BUCKET = process.env['S3_BUCKET'] ?? 'kyc-documents';
