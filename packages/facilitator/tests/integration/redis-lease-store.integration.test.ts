import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChannelStoreUnavailableError } from '../../src/modules/channels/core/channel-pool.js';
import {
  createChannelStoreClient,
  RedisLeaseStore,
} from '../../src/modules/channels/core/redis-lease-store.js';

const url = process.env.CHANNEL_STORE_URL!;
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const clients: Redis[] = [];

async function connectedClient(): Promise<Redis> {
  const redis = createChannelStoreClient(url, { commandTimeoutMs: 1_000, log });
  clients.push(redis);
  if (redis.status !== 'ready') await new Promise((resolve) => redis.once('ready', resolve));
  return redis;
}

async function seededStore(members: string[]): Promise<{ store: RedisLeaseStore; redis: Redis }> {
  const redis = await connectedClient();
  const store = new RedisLeaseStore(redis);
  await store.seed(members);
  return { store, redis };
}

const acquire = (store: RedisLeaseStore, ttlMs = 60_000) =>
  store.tryAcquire({ token: randomUUID(), ttlMs });

beforeEach(async () => {
  const redis = await connectedClient();
  await redis.flushdb();
});

afterAll(() => {
  for (const redis of clients) redis.disconnect();
});

describe('seeding the member set', () => {
  it('refuses to lease before this process has seeded', async () => {
    const store = new RedisLeaseStore(await connectedClient());

    await expect(acquire(store)).rejects.toBeInstanceOf(ChannelStoreUnavailableError);
  });

  it('writes the configured list into an empty store', async () => {
    const { store } = await seededStore(['GA', 'GB']);

    expect((await store.members()).sort()).toEqual(['GA', 'GB']);
  });

  it('leaves an existing member set alone', async () => {
    await seededStore(['GA']);
    const { store } = await seededStore(['GB', 'GC']);

    expect(await store.members()).toEqual(['GA']);
  });

  it('keeps exactly one list when instances seed concurrently', async () => {
    const [a, b] = await Promise.all([connectedClient(), connectedClient()]);
    await Promise.all([
      new RedisLeaseStore(a).seed(['GA', 'GB']),
      new RedisLeaseStore(b).seed(['GC', 'GD']),
    ]);

    const members = (await new RedisLeaseStore(a).members()).sort();
    expect([
      ['GA', 'GB'],
      ['GC', 'GD'],
    ]).toContainEqual(members);
  });
});

describe('leasing', () => {
  it('leases the least recently leased member and records the lease time', async () => {
    const { store, redis } = await seededStore(['GA', 'GB']);
    await redis.zadd('x402:channels', '500', 'GA');

    expect(await acquire(store)).toBe('GB');
    expect(Number(await redis.zscore('x402:channels', 'GB'))).toBeGreaterThan(500);
    expect(await acquire(store)).toBe('GA');
    expect(await acquire(store)).toBeUndefined();
  });

  it('never leases one channel twice when two instances race', async () => {
    const { store: first } = await seededStore(['GA', 'GB']);
    const second = new RedisLeaseStore(await connectedClient());
    await second.seed([]);

    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) => acquire(i % 2 ? first : second)),
    );

    const leased = results.filter((address) => address !== undefined);
    expect(leased.sort()).toEqual(['GA', 'GB']);
  });

  it('frees a channel whose lease expires without a finish', async () => {
    const { store } = await seededStore(['GA']);
    await acquire(store, 100);

    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(await acquire(store)).toBe('GA');
  });

  it('never leases a member removed from the set, and leases an added one first', async () => {
    const { store, redis } = await seededStore(['GA']);
    await redis.zadd('x402:channels', '9999999999999', 'GB');
    await redis.zrem('x402:channels', 'GA');
    await redis.zadd('x402:channels', 'NX', '0', 'GC');

    expect(await acquire(store)).toBe('GC');
    expect(await acquire(store)).toBe('GB');
    expect(await acquire(store)).toBeUndefined();
  });

  it('removes a member on request', async () => {
    const { store } = await seededStore(['GA', 'GB']);

    await store.removeMember('GA');

    expect(await store.members()).toEqual(['GB']);
  });
});

describe('finishing a lease', () => {
  it('deletes the lease when the hold is zero', async () => {
    const { store, redis } = await seededStore(['GA']);
    const token = randomUUID();
    await store.tryAcquire({ token, ttlMs: 60_000 });

    expect(await store.finish('GA', token, 0)).toBe(true);
    expect(await redis.exists('x402:lease:GA')).toBe(0);
  });

  it('keeps the lease for the hold when it is positive', async () => {
    const { store, redis } = await seededStore(['GA']);
    const token = randomUUID();
    await store.tryAcquire({ token, ttlMs: 60_000 });

    expect(await store.finish('GA', token, 5_000)).toBe(true);
    const ttl = await redis.pttl('x402:lease:GA');
    expect(ttl).toBeGreaterThan(4_000);
    expect(ttl).toBeLessThanOrEqual(5_000);
  });

  it('ignores a token that does not hold the lease', async () => {
    const { store, redis } = await seededStore(['GA']);
    await store.tryAcquire({ token: 'holder', ttlMs: 60_000 });

    expect(await store.finish('GA', 'stale', 0)).toBe(false);
    expect(await redis.get('x402:lease:GA')).toBe('holder');
  });

  it('reports a second finish of a released lease as not held', async () => {
    const { store } = await seededStore(['GA']);
    const token = randomUUID();
    await store.tryAcquire({ token, ttlMs: 60_000 });
    await store.finish('GA', token, 0);

    expect(await store.finish('GA', token, 0)).toBe(false);
  });
});

describe('an unreachable store', () => {
  it('fails at once with ChannelStoreUnavailableError instead of waiting', async () => {
    const down = createChannelStoreClient('redis://127.0.0.1:1', { commandTimeoutMs: 1_000, log });
    clients.push(down);
    const store = new RedisLeaseStore(down);
    const started = Date.now();

    await expect(store.seed(['GA'])).rejects.toBeInstanceOf(ChannelStoreUnavailableError);
    await expect(store.members()).rejects.toBeInstanceOf(ChannelStoreUnavailableError);
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});

describe('store errors are logged with the command and the original error', () => {
  it('logs a command an unreachable store fails, without the store URL', async () => {
    const commandLog = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const down = createChannelStoreClient('redis://:S3CRET@127.0.0.1:1', {
      commandTimeoutMs: 1_000,
      log: commandLog,
    });
    clients.push(down);
    const store = new RedisLeaseStore(down, { log: commandLog });

    await expect(store.seed(['GA'])).rejects.toBeInstanceOf(ChannelStoreUnavailableError);

    expect(commandLog.warn).toHaveBeenCalledWith(
      'channel_store_command_failed',
      expect.objectContaining({ command: 'seed', errorName: expect.any(String) }),
    );
    expect(JSON.stringify(commandLog.warn.mock.calls)).not.toContain('S3CRET');
  });

  it('logs a command a connected store refuses, which no connection event reports', async () => {
    const commandLog = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const redis = await connectedClient();
    // A members key of the wrong type: the store answers, but every command on it fails.
    await redis.set('x402:channels', 'not-a-sorted-set');
    const store = new RedisLeaseStore(redis, { log: commandLog });

    await store.seed(['GA']);
    await expect(store.tryAcquire({ token: randomUUID(), ttlMs: 60_000 })).rejects.toBeInstanceOf(
      ChannelStoreUnavailableError,
    );
    await expect(store.removeMember('GA')).rejects.toBeInstanceOf(ChannelStoreUnavailableError);

    expect(commandLog.warn).toHaveBeenCalledWith('channel_store_command_failed', {
      command: 'acquire',
      errorName: 'ReplyError',
      errorMessage: expect.stringContaining('WRONGTYPE'),
    });
    expect(commandLog.warn).toHaveBeenCalledWith(
      'channel_store_command_failed',
      expect.objectContaining({ command: 'removeMember', channel: 'GA', errorName: 'ReplyError' }),
    );
  });
});
