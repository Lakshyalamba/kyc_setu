import path from 'node:path';
import { loadEnvConfig } from '@next/env';
import type { NextConfig } from 'next';

// Single root .env for the whole monorepo.
loadEnvConfig(path.resolve(import.meta.dirname, '../..'));

const config: NextConfig = {
  reactStrictMode: true,
  transpilePackages: ['@kyc-setu/shared'],
  // Linting is run at the repo root (`pnpm lint`).
  eslint: { ignoreDuringBuilds: true },
};
export default config;
