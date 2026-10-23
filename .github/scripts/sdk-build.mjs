import { spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const sdk = new URL('../../packages/x402-sdk/', import.meta.url);
const require = createRequire(new URL('package.json', sdk));
rmSync(new URL('dist/', sdk), { recursive: true, force: true });
const result = spawnSync(
  process.execPath,
  [require.resolve('typescript/bin/tsc'), '-p', 'tsconfig.json'],
  {
    cwd: fileURLToPath(sdk),
    stdio: 'inherit',
  },
);
if (result.error) throw result.error;
process.exit(result.status ?? 1);
