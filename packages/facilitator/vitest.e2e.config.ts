import { existsSync } from 'node:fs';
import { BaseSequencer, type TestSpecification } from 'vitest/node';
import { defineConfig } from 'vitest/config';

// Local runs keep the target in an ignored .env; variables already set take precedence.
if (existsSync('.env')) process.loadEnvFile('.env');

// Fail loudly rather than skip: a missing target must not pass as green.
if (!process.env.E2E_FACILITATOR_URL) {
  throw new Error(
    'E2E_FACILITATOR_URL is required for e2e tests, e.g. https://devnet.agentsmith.xyz/facilitator ' +
      '(these tests spend testnet funds on that deployment)',
  );
}

/** The pool test fills every channel, so it runs after the files that need one free. */
class PoolLastSequencer extends BaseSequencer {
  override async sort(files: TestSpecification[]): Promise<TestSpecification[]> {
    const isPool = (file: TestSpecification) => file.moduleId.endsWith('channel-pool.e2e.test.ts');
    return [...files.filter((f) => !isPool(f)), ...files.filter(isPool)];
  }
}

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/e2e/**/*.e2e.test.ts'],
    fileParallelism: false,
    sequence: { sequencer: PoolLastSequencer },
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
