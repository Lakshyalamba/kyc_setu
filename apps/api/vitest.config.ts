import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    exclude: ['dist/**', 'node_modules/**'],
    globalSetup: ['test/globalSetup.ts'],
    testTimeout: 15_000,
  },
});
