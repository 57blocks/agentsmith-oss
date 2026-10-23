import { describe, expect, it, vi } from 'vitest';
import {
  ChannelPool,
  ChannelStoreUnavailableError,
  ChannelsBusyError,
} from '../src/modules/channels/core/channel-pool.js';
import type {
  SignerLoad,
  SignerProvider,
  StellarSigner,
} from '../src/modules/channels/core/stellar-signer.js';
import { FakeClock, FakeLeaseStore } from './fake-lease-store.js';

const policy = { cooldownMs: 6_000, unknownMarginMs: 30_000 };
const lease = { waitMs: 3_000, ttlMs: 60_000 };

function signerFor(address: string): StellarSigner {
  return { address, signTransaction: vi.fn(), signAuthEntry: vi.fn() };
}

/** Every address loads, except those listed as wrong (ok: false) or unreachable (throws). */
function signers(options: { wrong?: string[]; unreachable?: string[] } = {}) {
  const load = vi.fn(async (address: string): Promise<SignerLoad> => {
    if (options.unreachable?.includes(address)) throw new Error('TimeoutError');
    if (options.wrong?.includes(address)) return { ok: false, reason: 'key mismatch' };
    return { ok: true, signer: signerFor(address) };
  });
  return { mode: 'test', load } satisfies SignerProvider;
}

function setup(members: string[], provider: SignerProvider = signers()) {
  const clock = new FakeClock();
  const store = new FakeLeaseStore(clock, members);
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const pool = new ChannelPool({ store, signers: provider, policy, log, clock, random: () => 0 });
  return { clock, store, log, pool };
}

describe('leasing channels from the shared pool', () => {
  it('leases the least recently leased channel with its signer', async () => {
    const { pool, store } = setup(['GA', 'GB']);
    store.scores.set('GA', 500);

    const leased = await pool.acquire(lease);

    expect(leased.address).toBe('GB');
    expect(leased.signer.address).toBe('GB');
  });

  it('never leases one channel twice at once', async () => {
    const { pool } = setup(['GA', 'GB']);

    const first = await pool.acquire(lease);
    const second = await pool.acquire(lease);

    expect(new Set([first.address, second.address])).toEqual(new Set(['GA', 'GB']));
  });

  it('fails with ChannelsBusyError once the acquire wait passes with every channel leased', async () => {
    const { pool, clock } = setup(['GA']);
    await pool.acquire(lease);
    const started = clock.now();

    await expect(pool.acquire(lease)).rejects.toBeInstanceOf(ChannelsBusyError);
    expect(clock.now() - started).toBeGreaterThanOrEqual(lease.waitMs);
  });

  it('waits 20 ms plus up to 180 ms of jitter between attempts', async () => {
    const clock = new FakeClock();
    const store = new FakeLeaseStore(clock, ['GA']);
    const draws = [0, 0.5, 0.999];
    const pool = new ChannelPool({
      store,
      signers: signers(),
      policy,
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      clock,
      random: () => draws.shift() ?? 0,
    });
    await pool.acquire(lease);
    const sleep = vi.spyOn(clock, 'sleep');

    await expect(pool.acquire({ waitMs: 300, ttlMs: 60_000 })).rejects.toBeInstanceOf(
      ChannelsBusyError,
    );
    expect(sleep.mock.calls).toEqual([[20], [110], [199]]);
  });

  it('takes a channel that frees up during the acquire wait', async () => {
    const { pool } = setup(['GA']);
    const first = await pool.acquire(lease);
    const waiting = pool.acquire(lease);

    await first.finish({ kind: 'not-sent' });

    await expect(waiting).resolves.toMatchObject({ address: 'GA' });
  });

  it('passes ChannelStoreUnavailableError through when the store does not answer', async () => {
    const { pool, store } = setup(['GA']);
    store.available = false;

    await expect(pool.acquire(lease)).rejects.toBeInstanceOf(ChannelStoreUnavailableError);
  });
});

describe('a leased channel whose signer cannot be used', () => {
  it('removes a wrong account from the pool, logs why, and leases another channel', async () => {
    const { pool, store, log } = setup(['GA', 'GB'], signers({ wrong: ['GA'] }));

    const leased = await pool.acquire(lease);

    expect(leased.address).toBe('GB');
    expect(store.scores.has('GA')).toBe(false);
    expect(store.isLeased('GA')).toBe(false);
    expect(log.error).toHaveBeenCalledWith('channel_removed', {
      channel: 'GA',
      phase: 'acquire',
      signing: 'test',
      reason: 'key mismatch',
    });
  });

  it('releases a wrong account at once and leases another when its removal fails', async () => {
    const { pool, store, log } = setup(['GA', 'GB'], signers({ wrong: ['GA'] }));
    store.scores.set('GB', 500);
    store.failing.add('removeMember');

    const leased = await pool.acquire(lease);

    expect(leased.address).toBe('GB');
    expect(store.isLeased('GA')).toBe(false);
    expect(store.scores.has('GA')).toBe(true);
    expect(log.warn).toHaveBeenCalledWith('channel_remove_failed', {
      channel: 'GA',
      phase: 'acquire',
      signing: 'test',
      reason: 'key mismatch',
      errorName: 'ChannelStoreUnavailableError',
    });
    expect(log.error).not.toHaveBeenCalledWith('channel_removed', expect.anything());
  });

  it('tries the removal again the next time it picks a wrong account it could not remove', async () => {
    const { pool, store, log } = setup(['GA', 'GB'], signers({ wrong: ['GA'] }));
    store.scores.set('GB', 500);
    store.failing.add('removeMember');
    const held = await pool.acquire(lease);
    store.failing.clear();
    await held.finish({ kind: 'not-sent' });
    store.scores.set('GA', 0);

    await pool.acquire(lease);

    expect(store.scores.has('GA')).toBe(false);
    expect(log.error).toHaveBeenCalledWith(
      'channel_removed',
      expect.objectContaining({ channel: 'GA', phase: 'acquire' }),
    );
  });

  it('leases another channel when a failed signer load cannot be released', async () => {
    const { pool, store, log } = setup(['GA', 'GB'], signers({ unreachable: ['GA'] }));
    store.scores.set('GB', 500);
    store.failing.add('finish');

    const leased = await pool.acquire(lease);

    expect(leased.address).toBe('GB');
    expect(log.warn).toHaveBeenCalledWith('channel_lease_finish_failed', {
      channel: 'GA',
      outcome: 'not-sent',
      errorName: 'ChannelStoreUnavailableError',
    });
  });

  it('keeps a channel whose key store is unreachable, logs it, and leases another', async () => {
    const { pool, store, log } = setup(['GA', 'GB'], signers({ unreachable: ['GA'] }));

    const leased = await pool.acquire(lease);

    expect(leased.address).toBe('GB');
    expect(store.scores.has('GA')).toBe(true);
    expect(store.isLeased('GA')).toBe(false);
    expect(log.warn).toHaveBeenCalledWith('channel_signer_load_failed', {
      channel: 'GA',
      phase: 'acquire',
      signing: 'test',
      errorName: 'Error',
    });
  });

  it('ends in ChannelsBusyError when the only channel stays unreachable', async () => {
    const provider = signers({ unreachable: ['GA'] });
    const { pool } = setup(['GA'], provider);

    await expect(pool.acquire(lease)).rejects.toBeInstanceOf(ChannelsBusyError);
    expect(provider.load.mock.calls.length).toBeGreaterThan(1);
  });
});

describe('releasing a leased channel', () => {
  it('frees the channel at once when nothing was sent', async () => {
    const { pool, store } = setup(['GA']);
    const leased = await pool.acquire(lease);

    await leased.finish({ kind: 'not-sent' });

    expect(store.isLeased('GA')).toBe(false);
  });

  it('keeps the channel through its cooldown after inclusion', async () => {
    const { pool, store, clock } = setup(['GA']);
    const leased = await pool.acquire(lease);

    await leased.finish({ kind: 'included', hash: 'h', successful: true });

    expect(store.isLeased('GA')).toBe(true);
    clock.current += policy.cooldownMs;
    expect(store.isLeased('GA')).toBe(false);
  });

  it('applies only the first finish', async () => {
    const { pool, store, clock } = setup(['GA']);
    const leased = await pool.acquire(lease);
    const unknown = { kind: 'unknown' as const, validUntilMs: clock.now() + 60_000 };

    await leased.finish(unknown);
    await leased.finish({ kind: 'not-sent' });

    expect(store.isLeased('GA')).toBe(true);
  });

  it('logs and does not throw when the store cannot record the release', async () => {
    const { pool, store, log } = setup(['GA']);
    const leased = await pool.acquire(lease);
    store.available = false;

    await expect(leased.finish({ kind: 'not-sent' })).resolves.toBeUndefined();
    expect(log.warn).toHaveBeenCalledWith(
      'channel_lease_finish_failed',
      expect.objectContaining({ channel: 'GA' }),
    );
  });

  it('logs a lease that another holder has taken since it expired', async () => {
    const { pool, clock, log } = setup(['GA']);
    const leased = await pool.acquire(lease);
    clock.current += lease.ttlMs;
    await pool.acquire(lease);

    await leased.finish({ kind: 'not-sent' });

    expect(log.warn).toHaveBeenCalledWith('channel_lease_lost', {
      channel: 'GA',
      outcome: 'not-sent',
    });
  });
});

describe('preloading signers after the first seed', () => {
  it('loads every member and removes the wrong accounts', async () => {
    const provider = signers({ wrong: ['GB'] });
    const { pool, store, log } = setup(['GA', 'GB', 'GC'], provider);

    await pool.preload();

    expect(provider.load.mock.calls.map(([address]) => address)).toEqual(['GA', 'GB', 'GC']);
    expect([...store.scores.keys()]).toEqual(['GA', 'GC']);
    expect(log.error).toHaveBeenCalledWith(
      'channel_removed',
      expect.objectContaining({ channel: 'GB', phase: 'preload' }),
    );
  });

  it('goes on preloading when a wrong account cannot be removed', async () => {
    const { pool, store, log } = setup(['GA', 'GB', 'GC'], signers({ wrong: ['GA', 'GC'] }));
    store.failing.add('removeMember');

    await pool.preload();

    expect(log.warn).toHaveBeenCalledWith(
      'channel_remove_failed',
      expect.objectContaining({ channel: 'GA', phase: 'preload' }),
    );
    expect(log.warn).toHaveBeenCalledWith(
      'channel_remove_failed',
      expect.objectContaining({ channel: 'GC', phase: 'preload' }),
    );
  });

  it('keeps members whose key store is unreachable', async () => {
    const { pool, store } = setup(['GA'], signers({ unreachable: ['GA'] }));

    await pool.preload();

    expect(store.scores.has('GA')).toBe(true);
  });
});
