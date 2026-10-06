import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end tests drive the real stack: web (:3000) + api (:4000) + Postgres/Redis/MinIO.
 * Prereqs: `make up && pnpm db:migrate && pnpm seed` (the consent text comes from the seed).
 * The web and api servers are started here if they aren't already running.
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 90_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env['CI'] ? 1 : 0,
  reporter: process.env['CI'] ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: 'http://localhost:3000',
    trace: 'retain-on-failure',
    // Mobile-first product: test on a phone-sized viewport (Chromium engine).
    ...devices['Pixel 7'],
  },
  webServer: [
    {
      command: 'pnpm --filter @kyc-setu/api run dev:server',
      cwd: '../..',
      url: 'http://localhost:4000/healthz',
      reuseExistingServer: !process.env['CI'],
      timeout: 120_000,
    },
    {
      command: 'pnpm --filter @kyc-setu/web run dev',
      cwd: '../..',
      url: 'http://localhost:3000',
      reuseExistingServer: !process.env['CI'],
      timeout: 120_000,
    },
  ],
});
