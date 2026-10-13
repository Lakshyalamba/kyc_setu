import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/index.ts'],
      reporter: ['text-summary', 'json-summary'],
      // The gate CI and `make verify` enforce. It is a floor, not a target: the numbers are in docs/testing.md.
      thresholds: { statements: 80 },
    },
  },
});
