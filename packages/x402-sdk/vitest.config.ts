import { defineConfig } from 'vitest/config';

export default defineConfig({
  esbuild: { tsconfigRaw: { compilerOptions: { experimentalDecorators: true } } },
  test: {
    environment: 'node',
  },
});
