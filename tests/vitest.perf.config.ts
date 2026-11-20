import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { include: ['perf/**/*.test.ts'], testTimeout: 120_000, fileParallelism: false },
});
