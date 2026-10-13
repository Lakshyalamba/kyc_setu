import path from 'node:path';
import { loadEnvConfig } from '@next/env';
import type { NextConfig } from 'next';

// Single root .env for the whole monorepo.
loadEnvConfig(path.resolve(import.meta.dirname, '../..'));

const config: NextConfig = {
  reactStrictMode: true,
  // The floating dev-tools badge would be in every screenshot and in the demo recording. Error overlays still appear.
  devIndicators: false,
  transpilePackages: ['@kyc-setu/shared'],
  // Linting is run at the repo root (`pnpm lint`).
  eslint: { ignoreDuringBuilds: true },
};
export default config;
