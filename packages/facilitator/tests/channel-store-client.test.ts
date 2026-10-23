import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createChannelStoreClient,
  RedisLeaseStore,
} from '../src/modules/channels/core/redis-lease-store.js';
import { holdRedisBeforeConnecting } from './fake-redis.js';

beforeEach(() => {
  holdRedisBeforeConnecting();
});

afterEach(() => {
  vi.restoreAllMocks();
});

const log = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() });

describe('store client connection logs', () => {
  it('logs each outage once, without the store URL, and each recovery once', () => {
    const clientLog = log();
    const redis = createChannelStoreClient('redis://:S3CRET@127.0.0.1:6379', {
      commandTimeoutMs: 1_000,
      log: clientLog,
    });
    const refused = new Error('connect ECONNREFUSED redis://:S3CRET@127.0.0.1:6379');

    const unavailable = [
      'channel_store_unavailable',
      { errorName: 'Error', errorMessage: 'connect ECONNREFUSED <store url>' },
    ];

    for (const event of ['error', 'error', 'ready', 'ready', 'error', 'ready']) {
      redis.emit(event, refused);
    }

    expect(clientLog.warn.mock.calls).toEqual([unavailable, unavailable]);
    expect(clientLog.info.mock.calls).toEqual([['channel_store_ready'], ['channel_store_ready']]);
  });

  it('logs nothing when the first connection succeeds', () => {
    const clientLog = log();
    const redis = createChannelStoreClient('redis://127.0.0.1:6379', {
      commandTimeoutMs: 1_000,
      log: clientLog,
    });

    redis.emit('ready');

    expect(clientLog.info).not.toHaveBeenCalled();
    expect(clientLog.warn).not.toHaveBeenCalled();
  });
});

describe('store commands', () => {
  function store() {
    const redis = createChannelStoreClient('redis://127.0.0.1:6379', {
      commandTimeoutMs: 1_000,
      log: log(),
    });
    const leaseStore = new RedisLeaseStore(redis, { clock: { now: () => 42 } });
    return {
      leaseStore,
      acquire: vi.spyOn(redis, 'channelAcquire').mockResolvedValue('GA'),
      finish: vi.spyOn(redis, 'channelFinish').mockResolvedValue(1),
      seed: vi.spyOn(redis, 'channelSeed').mockResolvedValue(1),
    };
  }

  it('rounds a fractional lease TTL up to whole milliseconds', async () => {
    const { leaseStore, acquire } = store();
    const token = randomUUID();
    await leaseStore.seed(['GA']);

    expect(await leaseStore.tryAcquire({ token, ttlMs: 1_500.2 })).toBe('GA');
    expect(acquire).toHaveBeenCalledExactlyOnceWith(
      'x402:channels',
      token,
      1_501,
      42,
      'x402:lease:',
    );
  });

  it('rounds a fractional hold up to whole milliseconds', async () => {
    const { leaseStore, finish } = store();
    const token = randomUUID();

    expect(await leaseStore.finish('GA', token, 0.4)).toBe(true);
    expect(finish).toHaveBeenCalledExactlyOnceWith('x402:lease:GA', token, 1);
  });

  it('marks itself seeded by an empty channel list without sending a command', async () => {
    const { leaseStore, seed, acquire } = store();

    await leaseStore.seed([]);

    expect(seed).not.toHaveBeenCalled();
    expect(await leaseStore.tryAcquire({ token: randomUUID(), ttlMs: 1_000 })).toBe('GA');
    expect(acquire).toHaveBeenCalledOnce();
  });
});
