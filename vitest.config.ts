import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    setupFiles: ['tests/setup.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // The DB-touching integration tests share a Neon database; run serially.
    fileParallelism: false,
  },
  resolve: {
    alias: { '@': path.resolve(__dirname, '.') },
  },
});
