import { randomBytes } from 'node:crypto';
import { Keypair } from '@stellar/stellar-sdk';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../../src/config/facilitator.config.js';
import { createChannelRuntime } from '../../src/modules/channels/channel-runtime.js';
import { ChannelStoreUnavailableError } from '../../src/modules/channels/core/channel-pool.js';
import { createChannelStoreClient } from '../../src/modules/channels/core/redis-lease-store.js';
import { TEST_DATABASE_URL } from '../test-env.js';

const url = process.env.CHANNEL_STORE_URL!;
const randomKeypair = () => Keypair.fromRawEd25519Seed(randomBytes(32));

beforeEach(async () => {
  const redis = createChannelStoreClient(url, { commandTimeoutMs: 1_000, log: console });
  await new Promise((resolve) => redis.once('ready', resolve));
  await redis.flushdb();
  await redis.quit();
});

describe('channel runtime against a real store', () => {
  it('seeds from configuration, leases a channel with its signer, and disconnects on stop', async () => {
    const channel = randomKeypair();
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const config = loadConfig({
      DATABASE_URL: TEST_DATABASE_URL,
      FACILITATOR_STELLAR_FEE_BUMP_SECRET: randomKeypair().secret(),
      FACILITATOR_STELLAR_CHANNEL_SECRETS: channel.secret(),
      CHANNEL_STORE_URL: url,
    });
    const runtime = createChannelRuntime(config, log)!;

    runtime.start();
    await vi.waitFor(() =>
      expect(log.info).toHaveBeenCalledWith('channel_store_seeded', expect.anything()),
    );
    const lease = await runtime.pool.acquire({ waitMs: 1_000, ttlMs: 10_000 });
    expect(lease.address).toBe(channel.publicKey());
    expect(lease.signer.address).toBe(channel.publicKey());
    await lease.finish({ kind: 'not-sent' });

    await runtime.stop();
    await expect(runtime.pool.acquire({ waitMs: 0, ttlMs: 10_000 })).rejects.toBeInstanceOf(
      ChannelStoreUnavailableError,
    );
  });
});
