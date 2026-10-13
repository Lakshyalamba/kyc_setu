import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    exclude: ['dist/**', 'node_modules/**'],
    globalSetup: ['test/globalSetup.ts'],
    testTimeout: 15_000,
    // The integration suites share one database and TRUNCATE it, so test files must not overlap.
    fileParallelism: false,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/scripts/**', 'src/types/**', 'src/server.ts', 'src/worker.ts'],
      reporter: ['text-summary', 'json-summary'],
      // The gate CI and `make verify` enforce. It is a floor, not a target: the numbers are in docs/testing.md.
      thresholds: { statements: 80 },
    },
  },
});
