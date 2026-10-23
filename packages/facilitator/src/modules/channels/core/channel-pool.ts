import { randomUUID } from 'node:crypto';
import type { SignerProvider, StellarSigner } from './stellar-signer.js';
import type { SubmissionOutcome } from './transaction-pipeline.js';

/** Structured logging, shaped like the service logger so core takes no dependency on it. */
export interface ChannelLog {
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
}

/** Time and waiting, injected so tests control the acquire wait, backoff and holds. */
export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/** No channel could be leased within the acquire wait. */
export class ChannelsBusyError extends Error {
  override name = 'ChannelsBusyError';
}

/** The store did not answer, or has not been seeded yet. Nothing was leased. */
export class ChannelStoreUnavailableError extends Error {
  override name = 'ChannelStoreUnavailableError';
}

/**
 * Shared membership and leases. Every method may throw `ChannelStoreUnavailableError`.
 */
export interface LeaseStore {
  /**
   * Leases the least-recently-leased member that is not leased, records the lease time as its
   * order, and returns its address; undefined if none is free.
   */
  tryAcquire(request: { token: string; ttlMs: number }): Promise<string | undefined>;
  /**
   * Token-checked: keeps the lease `holdMs` longer, or deletes it when `holdMs` <= 0. False when the
   * token no longer holds the lease.
   */
  finish(address: string, token: string, holdMs: number): Promise<boolean>;
  /** Writes `addresses` only if the member set does not exist yet. */
  seed(addresses: readonly string[]): Promise<void>;
  members(): Promise<string[]>;
  /** For a member whose account is wrong for this deployment. */
  removeMember(address: string): Promise<void>;
}

export interface ReleasePolicy {
  cooldownMs: number;
  unknownMarginMs: number;
}

/**
 * How much longer a channel stays leased after a settlement: not at all if nothing was sent, a
 * cooldown once the sequence is known, and until the transaction can no longer be included when
 * the outcome is unknown. RPC nodes can briefly serve the previous sequence after inclusion, which
 * is what the cooldown absorbs.
 */
export function releaseHoldMs(
  outcome: SubmissionOutcome,
  policy: ReleasePolicy,
  nowMs: number,
): number {
  switch (outcome.kind) {
    case 'not-sent':
      return 0;
    case 'rejected':
    case 'included':
      return policy.cooldownMs;
    case 'unknown':
      return Math.max(0, outcome.validUntilMs - nowMs) + policy.unknownMarginMs;
  }
}

export interface Lease {
  readonly address: string;
  readonly signer: StellarSigner;
  /** Applies the release policy once; later calls are no-ops. Never throws. */
  finish(outcome: SubmissionOutcome): Promise<void>;
}

export interface ChannelPoolDeps {
  store: LeaseStore;
  signers: SignerProvider;
  policy: ReleasePolicy;
  log: ChannelLog;
  clock?: Clock;
  /** Uniform in [0, 1); injected so tests can fix the backoff. */
  random?: () => number;
}

type Phase = 'preload' | 'acquire';

/** A loaded signer, a wrong account with its reason, or neither when the key store failed. */
interface LoadedSigner {
  signer?: StellarSigner;
  wrongAccount?: string;
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'unknown';
}

const BACKOFF_MIN_MS = 20;
const BACKOFF_SPREAD_MS = 180;

class PoolLease implements Lease {
  private finished = false;

  constructor(
    readonly address: string,
    readonly signer: StellarSigner,
    private readonly token: string,
    private readonly deps: Required<Pick<ChannelPoolDeps, 'store' | 'policy' | 'log' | 'clock'>>,
  ) {}

  async finish(outcome: SubmissionOutcome): Promise<void> {
    if (this.finished) return;
    this.finished = true;
    const { store, policy, log, clock } = this.deps;
    const holdMs = releaseHoldMs(outcome, policy, clock.now());
    try {
      const held = await store.finish(this.address, this.token, holdMs);
      if (!held) log.warn('channel_lease_lost', { channel: this.address, outcome: outcome.kind });
    } catch (error) {
      // The lease then runs to its TTL, which outlasts any transaction it could have sent.
      log.warn('channel_lease_finish_failed', {
        channel: this.address,
        outcome: outcome.kind,
        errorName: errorName(error),
      });
    }
  }
}

/** Leases channels from the shared store and hands each out with its checked signer. */
export class ChannelPool {
  private readonly deps: Required<ChannelPoolDeps>;

  constructor(deps: ChannelPoolDeps) {
    this.deps = { clock: systemClock, random: Math.random, ...deps };
  }

  /** Loads and checks every member's signer, removing wrong accounts. Run once after seeding. */
  async preload(): Promise<void> {
    for (const address of await this.deps.store.members()) {
      const loaded = await this.loadSigner(address, 'preload');
      if (loaded.wrongAccount)
        await this.removeWrongAccount(address, 'preload', loaded.wrongAccount);
    }
  }

  /**
   * Throws `ChannelsBusyError` when no usable channel frees up within `waitMs`, and
   * `ChannelStoreUnavailableError` when the store does not answer.
   */
  async acquire(options: { waitMs: number; ttlMs: number }): Promise<Lease> {
    const { store, clock } = this.deps;
    const deadline = clock.now() + options.waitMs;
    const token = randomUUID();
    for (;;) {
      const address = await store.tryAcquire({ token, ttlMs: options.ttlMs });
      if (address) {
        const loaded = await this.loadSigner(address, 'acquire');
        if (loaded.signer) return new PoolLease(address, loaded.signer, token, this.deps);
        // Released before the removal, so a removal that fails cannot keep the lease to its TTL.
        await this.releaseUnused(address, token);
        if (loaded.wrongAccount)
          await this.removeWrongAccount(address, 'acquire', loaded.wrongAccount);
      }
      if (clock.now() >= deadline) {
        throw new ChannelsBusyError(`no channel freed up within ${options.waitMs} ms`);
      }
      await clock.sleep(BACKOFF_MIN_MS + Math.floor(this.deps.random() * BACKOFF_SPREAD_MS));
    }
  }

  /**
   * A wrong account is reported for removal; an unreachable key store only skips the member this
   * time, so an outage cannot empty the pool.
   */
  private async loadSigner(address: string, phase: Phase): Promise<LoadedSigner> {
    const { signers, log } = this.deps;
    try {
      const loaded = await signers.load(address);
      return loaded.ok ? { signer: loaded.signer } : { wrongAccount: loaded.reason };
    } catch (error) {
      log.warn('channel_signer_load_failed', {
        ...this.channelFields(address, phase),
        errorName: errorName(error),
      });
      return {};
    }
  }

  /** Ends a lease that never signed. A failure is logged; the lease then runs to its TTL. */
  private async releaseUnused(address: string, token: string): Promise<void> {
    try {
      await this.deps.store.finish(address, token, 0);
    } catch (error) {
      this.deps.log.warn('channel_lease_finish_failed', {
        channel: address,
        outcome: 'not-sent',
        errorName: errorName(error),
      });
    }
  }

  /**
   * Removes a wrong account for every instance. A failed removal leaves the member in place: it is
   * never signed with, since its signer never loads, and the next pick of it tries again.
   */
  private async removeWrongAccount(address: string, phase: Phase, reason: string): Promise<void> {
    const fields = { ...this.channelFields(address, phase), reason };
    try {
      await this.deps.store.removeMember(address);
    } catch (error) {
      this.deps.log.warn('channel_remove_failed', { ...fields, errorName: errorName(error) });
      return;
    }
    this.deps.log.error('channel_removed', fields);
  }

  private channelFields(address: string, phase: Phase) {
    return { channel: address, phase, signing: this.deps.signers.mode };
  }
}
