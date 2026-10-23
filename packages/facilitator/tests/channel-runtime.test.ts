import { randomBytes } from 'node:crypto';
import { Keypair } from '@stellar/stellar-sdk';
import { Redis } from 'ioredis';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config/facilitator.config.js';
import { createChannelRuntime } from '../src/modules/channels/channel-runtime.js';
import { ChannelStoreUnavailableError } from '../src/modules/channels/core/channel-pool.js';
import { RedisLeaseStore } from '../src/modules/channels/core/redis-lease-store.js';
import { fakeKms } from './fake-kms.js';
import { holdRedisBeforeConnecting } from './fake-redis.js';
import { FakeClock, FakeLeaseStore } from './fake-lease-store.js';
import { TEST_DATABASE_URL } from './test-env.js';

const randomKeypair = () => Keypair.fromRawEd25519Seed(randomBytes(32));
const log = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() });

function envConfig(channels: Keypair[], overrides: NodeJS.ProcessEnv = {}) {
  return loadConfig({
    DATABASE_URL: TEST_DATABASE_URL,
    CHANNEL_STORE_URL: 'redis://127.0.0.1:6379/15',
    FACILITATOR_API_KEY: 'test-only-token',
    FACILITATOR_STELLAR_FEE_BUMP_SECRET: randomKeypair().secret(),
    FACILITATOR_STELLAR_CHANNEL_SECRETS: channels.map((c) => c.secret()).join(','),
    ...overrides,
  });
}

/** Resolves once `predicate` holds, letting background promises run in between. */
async function until(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && !predicate(); i += 1) await new Promise((r) => setImmediate(r));
  expect(predicate()).toBe(true);
}

describe('channel runtime', () => {
  it('seeds the KMS channel addresses and removes one whose alias points at another key', async () => {
    const [feePayer, good, bad] = [randomKeypair(), randomKeypair(), randomKeypair()];
    const config = loadConfig({
      DATABASE_URL: TEST_DATABASE_URL,
      CHANNEL_STORE_URL: 'redis://127.0.0.1:6379/15',
      FACILITATOR_API_KEY: 'test-only-token',
      FACILITATOR_SIGNING_MODE: 'kms',
      FACILITATOR_KMS_REGION: 'us-west-1',
      FACILITATOR_KMS_FEE_PAYER_ADDRESS: feePayer.publicKey(),
      FACILITATOR_KMS_CHANNEL_ADDRESSES: `${good.publicKey()},${bad.publicKey()}`,
    });
    const kms = fakeKms([feePayer, good], { aliasTo: { [bad.publicKey()]: randomKeypair() } });
    const store = new FakeLeaseStore(new FakeClock());
    const runtimeLog = log();
    const runtime = createChannelRuntime(config, runtimeLog, { store, kms: kms.client });

    runtime.start();

    await until(() => store.scores.size === 1);
    expect(await store.members()).toEqual([good.publicKey()]);
    expect(runtimeLog.error).toHaveBeenCalledWith(
      'channel_removed',
      expect.objectContaining({ channel: bad.publicKey(), phase: 'preload', signing: 'kms' }),
    );
    const lease = await runtime.pool.acquire({ waitMs: 0, ttlMs: 10_000 });
    expect(lease.signer.address).toBe(good.publicKey());
    await runtime.stop();
  });

  it('seeds an empty store with the configured channels, then preloads their signers', async () => {
    const channels = [randomKeypair(), randomKeypair()];
    const store = new FakeLeaseStore(new FakeClock());
    const runtimeLog = log();
    const runtime = createChannelRuntime(envConfig(channels), runtimeLog, { store })!;

    runtime.start();

    await until(() => runtimeLog.info.mock.calls.length > 0);
    expect(await store.members()).toEqual(channels.map((c) => c.publicKey()));
    expect(runtimeLog.info).toHaveBeenCalledWith('channel_store_seeded', {
      configuredChannels: 2,
    });
    await runtime.stop();
  });

  it('keeps retrying the seed with growing waits until the store answers', async () => {
    const store = new FakeLeaseStore(new FakeClock());
    store.available = false;
    const waits: number[] = [];
    const wait = vi.fn(async (ms: number) => {
      waits.push(ms);
      if (waits.length === 3) store.available = true;
    });
    const runtime = createChannelRuntime(envConfig([randomKeypair()]), log(), { store, wait })!;

    runtime.start();

    await until(() => store.scores.size === 1);
    expect(waits).toEqual([1_000, 2_000, 4_000]);
    await runtime.stop();
  });

  it('removes a seeded member the deployment holds no key for while preloading', async () => {
    const stranger = randomKeypair().publicKey();
    const store = new FakeLeaseStore(new FakeClock(), [stranger]);
    const runtimeLog = log();
    const runtime = createChannelRuntime(envConfig([randomKeypair()]), runtimeLog, { store })!;

    runtime.start();

    await until(() => !store.scores.has(stranger));
    expect(runtimeLog.error).toHaveBeenCalledWith(
      'channel_removed',
      expect.objectContaining({ channel: stranger, phase: 'preload', signing: 'env' }),
    );
    await runtime.stop();
  });

  it('stops retrying the seed when stopped', async () => {
    const store = new FakeLeaseStore(new FakeClock());
    store.available = false;
    const wait = vi.fn(
      (_ms: number, signal: AbortSignal) =>
        new Promise<void>((_, reject) =>
          signal.addEventListener('abort', () => reject(signal.reason)),
        ),
    );
    const runtime = createChannelRuntime(envConfig([randomKeypair()]), log(), { store, wait })!;

    runtime.start();
    await until(() => wait.mock.calls.length === 1);
    await runtime.stop();

    expect(wait).toHaveBeenCalledTimes(1);
    expect(store.scores.size).toBe(0);
  });

  it('logs a seed error that is not a store outage as a bug, and keeps retrying', async () => {
    const store = new FakeLeaseStore(new FakeClock());
    const seed = vi.spyOn(store, 'seed');
    seed
      .mockRejectedValueOnce(new ChannelStoreUnavailableError('down'))
      .mockRejectedValueOnce(new TypeError('bad reply'));
    const runtimeLog = log();
    const runtime = createChannelRuntime(envConfig([randomKeypair()]), runtimeLog, {
      store,
      wait: async () => {},
    });

    runtime.start();

    await until(() => store.scores.size === 1);
    expect(seed).toHaveBeenCalledTimes(3);
    expect(runtimeLog.error.mock.calls).toEqual([
      ['channel_store_seed_failed', { errorName: 'TypeError' }],
    ]);
    await runtime.stop();
  });

  it('logs a preload that fails and leaves members to load on their first acquire', async () => {
    const store = new FakeLeaseStore(new FakeClock());
    vi.spyOn(store, 'members').mockRejectedValueOnce(new ChannelStoreUnavailableError('down'));
    const runtimeLog = log();
    const channel = randomKeypair();
    const runtime = createChannelRuntime(envConfig([channel]), runtimeLog, { store });

    runtime.start();

    await until(() => runtimeLog.warn.mock.calls.length > 0);
    expect(runtimeLog.warn.mock.calls).toEqual([
      ['channel_preload_failed', { errorName: 'ChannelStoreUnavailableError' }],
    ]);
    const lease = await runtime.pool.acquire({ waitMs: 0, ttlMs: 10_000 });
    expect(lease.signer.address).toBe(channel.publicKey());
    await runtime.stop();
  });

  it('caps the seed retry wait at 30 seconds', async () => {
    const store = new FakeLeaseStore(new FakeClock());
    store.available = false;
    const waits: number[] = [];
    const wait = vi.fn(async (ms: number) => {
      waits.push(ms);
      if (waits.length === 7) store.available = true;
    });
    const runtime = createChannelRuntime(envConfig([randomKeypair()]), log(), { store, wait });

    runtime.start();

    await until(() => store.scores.size === 1);
    expect(waits).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000]);
    await runtime.stop();
  });

  it('seeds once however often it is started', async () => {
    const store = new FakeLeaseStore(new FakeClock());
    const seed = vi.spyOn(store, 'seed');
    const runtime = createChannelRuntime(envConfig([randomKeypair()]), log(), { store });

    runtime.start();
    runtime.start();

    await until(() => store.scores.size === 1);
    runtime.start();
    await new Promise((resolve) => setImmediate(resolve));
    expect(seed).toHaveBeenCalledOnce();
    await runtime.stop();
  });
});

describe('channel runtime on its own store client', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function heldBeforeConnecting() {
    const clients = holdRedisBeforeConnecting();
    const disconnect = vi.spyOn(Redis.prototype, 'disconnect').mockImplementation(() => {});
    const runtime = createChannelRuntime(envConfig([randomKeypair()]), log());
    return { runtime, client: clients[0]!, disconnect };
  }

  it('waits for the store connection to be ready before seeding', async () => {
    vi.spyOn(Redis.prototype, 'quit').mockResolvedValue('OK');
    const seed = vi.spyOn(RedisLeaseStore.prototype, 'seed').mockResolvedValue();
    const { runtime, client } = heldBeforeConnecting();

    runtime.start();
    await new Promise((resolve) => setImmediate(resolve));
    expect(seed).not.toHaveBeenCalled();

    client.emit('ready');
    await until(() => seed.mock.calls.length === 1);
    await runtime.stop();
  });

  it('stops while waiting for the store connection, and quits the client', async () => {
    const quit = vi.spyOn(Redis.prototype, 'quit').mockResolvedValue('OK');
    const seed = vi.spyOn(RedisLeaseStore.prototype, 'seed');
    const { runtime, disconnect } = heldBeforeConnecting();

    runtime.start();
    await new Promise((resolve) => setImmediate(resolve));
    await runtime.stop();

    expect(seed).not.toHaveBeenCalled();
    expect(quit).toHaveBeenCalledOnce();
    expect(disconnect).not.toHaveBeenCalled();
  });

  it('disconnects the client when quitting fails', async () => {
    vi.spyOn(Redis.prototype, 'quit').mockRejectedValue(new Error('Connection is closed.'));
    const { runtime, disconnect } = heldBeforeConnecting();

    await runtime.stop();

    expect(disconnect).toHaveBeenCalledOnce();
  });
});
