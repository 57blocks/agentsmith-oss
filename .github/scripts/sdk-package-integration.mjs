import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const sdk = join(root, 'packages/x402-sdk');
const manifest = JSON.parse(readFileSync(join(sdk, 'package.json'), 'utf8'));
const temporary = mkdtempSync(join(tmpdir(), 'agentsmith-sdk-consumer-'));
const consumer = join(temporary, 'consumer');

function run(binary, args, cwd, env = process.env) {
  const result = spawnSync(binary, args, { cwd, env, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`${binary} exited with status ${result.status}`);
}

try {
  const stale = join(sdk, 'dist/__stale-build-test__.js');
  mkdirSync(join(sdk, 'dist'), { recursive: true });
  writeFileSync(stale, 'export const stale = true;\n');
  run('corepack', ['pnpm', '--filter', manifest.name, 'run', 'build'], root);
  assert.equal(
    existsSync(stale),
    false,
    'SDK build must remove stale output before packing',
  );
  run('corepack', ['pnpm', 'pack', '--pack-destination', temporary], sdk);
  mkdirSync(consumer);
  const dependencyNames = [
    '@stellar/stellar-sdk',
    '@x402/core',
    '@x402/stellar',
    '@x402/express',
    'express',
    '@nestjs/common',
    '@nestjs/core',
    '@nestjs/platform-express',
    'reflect-metadata',
    'rxjs',
    'vitest',
  ];
  const versions = { ...manifest.devDependencies, ...manifest.dependencies };
  writeFileSync(
    join(consumer, 'package.json'),
    JSON.stringify(
      {
        name: 'agentsmith-sdk-consumer-test',
        private: true,
        type: 'module',
        dependencies: {
          ...Object.fromEntries(
            dependencyNames.map((name) => [name, versions[name]]),
          ),
          [manifest.name]: `file:../${manifest.name}-${manifest.version}.tgz`,
        },
      },
      null,
      2,
    ),
  );
  cpSync(join(sdk, 'tests/integration'), join(consumer, 'tests/integration'), {
    recursive: true,
  });
  cpSync(join(sdk, 'vitest.config.ts'), join(consumer, 'vitest.config.ts'));
  const installEnv = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !key.toLowerCase().startsWith('npm_config_'),
    ),
  );
  run(
    'npm',
    [
      'install',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--registry=https://registry.npmjs.org',
    ],
    consumer,
    installEnv,
  );
  const installed = JSON.parse(
    readFileSync(
      join(consumer, 'node_modules', manifest.name, 'package.json'),
      'utf8',
    ),
  );
  assert.equal(installed.name, manifest.name);
  assert.equal(installed.version, manifest.version);
  assert.equal(installed.pnpm?.patchedDependencies, undefined);
  assert.equal(existsSync(join(consumer, 'patches')), false);
  assert.equal(
    existsSync(
      join(consumer, 'node_modules', manifest.name, '.env.integration'),
    ),
    false,
  );
  console.log(
    JSON.stringify({
      kind: 'package-consumer-evidence',
      name: installed.name,
      version: installed.version,
      tarballSha256: createHash('sha256')
        .update(
          readFileSync(
            join(temporary, `${manifest.name}-${manifest.version}.tgz`),
          ),
        )
        .digest('hex'),
      officialX402Version: installed.dependencies['@x402/core'],
      patches: [],
    }),
  );
  // Mirror the SDK's local .env.integration into the consumer so the integration tests load it from
  // their working directory. CI has no such file and passes the Seller env directly instead.
  const envFile = join(sdk, '.env.integration');
  if (existsSync(envFile)) cpSync(envFile, join(consumer, '.env.integration'));
  const env = { ...process.env };
  // Resolve every import inside the new project, including native x402 dependencies.
  delete env.NODE_PATH;
  run(
    process.execPath,
    [
      join(consumer, 'node_modules/vitest/vitest.mjs'),
      'run',
      'tests/integration',
      ...process.argv.slice(2),
    ],
    consumer,
    env,
  );
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
