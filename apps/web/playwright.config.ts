import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end tests drive the real stack: web (:3000) + api (:4000) + Postgres/Redis/MinIO.
 * Prereqs: `make up && pnpm db:migrate && pnpm seed --yes` (the consent text comes from the seed).
 * The web and api servers and the queue worker are started here if they aren't already running.
 * The OCR specs (kyc-extraction) also need the AI service: `make ai` (Docker) or `pnpm dev:ai`.
 */
const video = process.env['E2E_VIDEO'] === 'on';

export default defineConfig({
  testDir: './e2e',
  // Videos, traces and failure screenshots land here (git-ignored), where CI picks them up.
  outputDir: '../../test-artifacts/playwright',
  timeout: 90_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env['CI'] ? 1 : 0,
  reporter: process.env['CI']
    ? [
        ['github'],
        ['list'],
        ['html', { open: 'never', outputFolder: '../../test-artifacts/html-report' }],
      ]
    : 'list',
  use: {
    baseURL: 'http://localhost:3000',
    trace: 'retain-on-failure',
    // `E2E_VIDEO=on` records every test (the three journeys are the ones worth watching).
    video: video ? { mode: 'on', size: { width: 1280, height: 800 } } : 'off',
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
      // The queue worker has no HTTP port, so wait for its log line instead of a URL.
      command: 'pnpm --filter @kyc-setu/api run dev:worker',
      cwd: '../..',
      wait: { stdout: /"queue":"verification"[^\n]*"msg":"listening"/ },
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
