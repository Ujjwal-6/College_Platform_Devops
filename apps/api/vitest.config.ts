import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // Tests share one real PostgreSQL database, so files run one after another.
    fileParallelism: false,
    globalSetup: ['./test/globalSetup.ts'],
    include: ['test/**/*.test.ts'],
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
});
