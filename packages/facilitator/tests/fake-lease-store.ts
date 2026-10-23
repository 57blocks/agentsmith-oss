import { getNetworkPassphrase } from '@x402/stellar';
import {
  ChannelPool,
  ChannelStoreUnavailableError,
  type Clock,
  type LeaseStore,
} from '../src/modules/channels/core/channel-pool.js';
import { EnvSignerProvider, withSignerCache } from '../src/modules/channels/core/stellar-signer.js';

/** A clock that only moves when a test moves it; `sleep` advances it instead of waiting. */
export class FakeClock implements Clock {
  constructor(public current = 1_000_000) {}

  now(): number {
    return this.current;
  }

  async sleep(ms: number): Promise<void> {
    this.current += ms;
  }
}

interface FakeLease {
  token: string;
  expiresAt: number;
}

/**
 * In-memory `LeaseStore` with the Redis store's semantics: least-recently-leased first, token-checked
 * finish, expiry by the injected clock. Unit tests only; production has no in-memory store.
 */
export class FakeLeaseStore implements LeaseStore {
  readonly scores = new Map<string, number>();
  readonly leases = new Map<string, FakeLease>();
  available = true;
  /** Commands that fail while the rest of the store answers, like one command timing out. */
  readonly failing = new Set<'finish' | 'removeMember'>();

  constructor(
    private readonly clock: Clock,
    members: readonly string[] = [],
  ) {
    for (const member of members) this.scores.set(member, 0);
  }

  async tryAcquire(request: { token: string; ttlMs: number }): Promise<string | undefined> {
    this.ensureAvailable();
    const now = this.clock.now();
    const ordered = [...this.scores.entries()].sort((a, b) => a[1] - b[1]);
    for (const [member] of ordered) {
      if (this.isLeased(member, now)) continue;
      this.leases.set(member, { token: request.token, expiresAt: now + request.ttlMs });
      this.scores.set(member, now);
      return member;
    }
    return undefined;
  }

  async finish(address: string, token: string, holdMs: number): Promise<boolean> {
    this.ensureAvailable('finish');
    const lease = this.leases.get(address);
    if (!lease || lease.token !== token || lease.expiresAt <= this.clock.now()) return false;
    if (holdMs <= 0) this.leases.delete(address);
    else lease.expiresAt = this.clock.now() + holdMs;
    return true;
  }

  async seed(addresses: readonly string[]): Promise<void> {
    this.ensureAvailable();
    if (this.scores.size > 0) return;
    for (const address of addresses) this.scores.set(address, 0);
  }

  async members(): Promise<string[]> {
    this.ensureAvailable();
    return [...this.scores.keys()];
  }

  async removeMember(address: string): Promise<void> {
    this.ensureAvailable('removeMember');
    this.scores.delete(address);
  }

  isLeased(member: string, now = this.clock.now()): boolean {
    const lease = this.leases.get(member);
    return lease !== undefined && lease.expiresAt > now;
  }

  private ensureAvailable(command?: 'finish' | 'removeMember'): void {
    if (!this.available || (command && this.failing.has(command))) {
      throw new ChannelStoreUnavailableError('fake store is down');
    }
  }
}

export interface FakeChannelPool {
  pool: ChannelPool;
  store: FakeLeaseStore;
  clock: FakeClock;
}

/**
 * A pool over the in-memory store, seeded with the addresses `channelSecrets` derive (or only
 * `seeded`, to add members later), signing with those secrets. Acquire retries without jitter.
 */
export function fakeChannelPool(
  channelSecrets: readonly string[],
  options: { clock?: FakeClock; seeded?: readonly string[] } = {},
): FakeChannelPool {
  const clock = options.clock ?? new FakeClock();
  const provider = new EnvSignerProvider(channelSecrets, getNetworkPassphrase('stellar:testnet'));
  const store = new FakeLeaseStore(clock, options.seeded ?? provider.addresses());
  const pool = new ChannelPool({
    store,
    signers: withSignerCache(provider),
    policy: { cooldownMs: 6_000, unknownMarginMs: 30_000 },
    log: { info: () => {}, warn: () => {}, error: () => {} },
    clock,
    random: () => 0,
  });
  return { pool, store, clock };
}
