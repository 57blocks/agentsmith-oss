import { existsSync } from 'node:fs';
import { defineConfig } from 'vitest/config';

// Local runs keep the store URL in an ignored .env; variables already set take precedence.
if (existsSync('.env')) process.loadEnvFile('.env');

// Fail loudly rather than skip: a missing store must not pass as green.
if (!process.env.CHANNEL_STORE_URL) {
  throw new Error(
    'CHANNEL_STORE_URL is required for integration tests, e.g. redis://127.0.0.1:6379/15 ' +
      '(start one with `docker compose up -d valkey`)',
  );
}

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/integration/**/*.integration.test.ts'],
    // The suites share one database and flush it between tests.
    fileParallelism: false,
  },
});
