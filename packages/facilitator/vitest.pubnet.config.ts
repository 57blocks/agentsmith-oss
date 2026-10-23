import { existsSync } from 'node:fs';
import { defineConfig } from 'vitest/config';

// Local runs keep the key and seeds in an ignored file; variables already set take precedence.
if (existsSync('.env.pubnet')) process.loadEnvFile('.env.pubnet');

// Fail loudly rather than skip: a missing target must not pass as green.
for (const name of ['E2E_FACILITATOR_URL', 'E2E_API_KEY', 'E2E_RPC_URL']) {
  if (!process.env[name]) {
    throw new Error(
      `${name} is required for the pubnet smoke test, e.g. from packages/facilitator/.env.pubnet ` +
        '(with E2E_ALLOW_PUBNET_SPEND=true it spends real funds on that deployment)',
    );
  }
}

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/e2e/**/*.pubnet.test.ts'],
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
