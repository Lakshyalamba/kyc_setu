import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    exclude: ['dist/**', 'node_modules/**'],
    globalSetup: ['test/globalSetup.ts'],
    testTimeout: 15_000,
    // The integration suites share one database and TRUNCATE it, so test files must not overlap.
    fileParallelism: false,
  },
});
