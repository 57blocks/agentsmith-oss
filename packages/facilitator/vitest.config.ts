import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // Integration tests need a running store and e2e tests a deployment; they run with
    // `test:integration` and `test:e2e`, not `pnpm check`.
    exclude: [...configDefaults.exclude, 'tests/integration/**', 'tests/e2e/**'],
    coverage: { reporter: ['text'] },
  },
});
