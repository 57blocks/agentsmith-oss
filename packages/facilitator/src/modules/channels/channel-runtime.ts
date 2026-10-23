import { setTimeout as delay } from 'node:timers/promises';
import type { Redis } from 'ioredis';
import { getNetworkPassphrase } from '@x402/stellar';
import type { Logger } from '../../common/logger.js';
import type { FacilitatorConfig } from '../../config/facilitator.config.js';
import { ChannelPool, ChannelStoreUnavailableError, type LeaseStore } from './core/channel-pool.js';
import { createChannelStoreClient, RedisLeaseStore } from './core/redis-lease-store.js';
import { EnvSignerProvider, withSignerCache, type SignerProvider } from './core/stellar-signer.js';
import { createAwsKmsClient } from './kms/aws-kms-client.js';
import { KmsSignerProvider } from './kms/kms-signer-provider.js';
import type { KmsSigningClient } from './kms/kms-signer.js';

const SEED_RETRY_MIN_MS = 1_000;
const SEED_RETRY_MAX_MS = 30_000;

/** The shared pool and the background work that keeps it usable. */
export interface ChannelRuntime {
  readonly pool: ChannelPool;
  /**
   * Seeds an empty store with the configured channels, retrying until it succeeds, then preloads
   * every member's signer. Runs in the background; never throws.
   */
  start(): void;
  /** Stops the background work and closes the store connection. */
  stop(): Promise<void>;
}

/** Waits `ms`, rejecting early when `signal` aborts. */
type Wait = (ms: number, signal: AbortSignal) => Promise<void>;

export interface ChannelRuntimeDeps {
  /** Replaces Redis; tests pass an in-memory store. */
  store?: LeaseStore;
  /** Replaces real time in the seed retry. */
  wait?: Wait;
  /** The KMS client in `kms` signing mode; shared with the fee payer's, or a fake in tests. */
  kms?: KmsSigningClient;
}

interface RuntimeParts {
  pool: ChannelPool;
  store: LeaseStore;
  seeds: readonly string[];
  log: Logger;
  close: () => Promise<void>;
  wait: Wait;
  /**
   * Resolves once the store connection is up, or rejects when `signal` aborts. Seeding waits for
   * it: the client connects in the background, so a seed sent at once would always fail.
   */
  connected: (signal: AbortSignal) => Promise<void>;
}

interface ChannelSources {
  provider: SignerProvider;
  /** The list that seeds an empty store. */
  seeds: readonly string[];
}

function channelSources(
  config: FacilitatorConfig,
  log: Logger,
  kmsClient?: KmsSigningClient,
): ChannelSources {
  const passphrase = getNetworkPassphrase(config.network);
  if (config.signingMode !== 'kms') {
    const provider = new EnvSignerProvider(config.channelSecrets, passphrase);
    return { provider, seeds: provider.addresses() };
  }
  if (!config.kms) throw new Error('kms signing mode has no KMS configuration');
  const client = kmsClient ?? createAwsKmsClient(config.kms.region);
  return {
    provider: new KmsSignerProvider(client, passphrase, log),
    seeds: config.kms.channelAddresses,
  };
}

class Runtime implements ChannelRuntime {
  private readonly stopping = new AbortController();
  private running?: Promise<void>;

  readonly pool: ChannelPool;

  constructor(private readonly parts: RuntimeParts) {
    this.pool = parts.pool;
  }

  start(): void {
    this.running ??= this.seedThenPreload();
  }

  async stop(): Promise<void> {
    this.stopping.abort();
    await this.running;
    await this.parts.close();
  }

  private async seedThenPreload(): Promise<void> {
    try {
      await this.parts.connected(this.stopping.signal);
    } catch {
      return; // stopped before the store ever answered
    }
    if (!(await this.seedUntilDone())) return;
    try {
      await this.pool.preload();
    } catch (error) {
      // Members not preloaded load on their first acquire instead.
      this.parts.log.warn('channel_preload_failed', { errorName: errorName(error) });
    }
  }

  private async seedUntilDone(): Promise<boolean> {
    let retryMs = SEED_RETRY_MIN_MS;
    while (!this.stopping.signal.aborted) {
      try {
        await this.parts.store.seed(this.parts.seeds);
        this.parts.log.info('channel_store_seeded', {
          configuredChannels: this.parts.seeds.length,
        });
        return true;
      } catch (error) {
        // A down store is already logged once per outage by its client; anything else is a bug.
        if (!(error instanceof ChannelStoreUnavailableError)) {
          this.parts.log.error('channel_store_seed_failed', { errorName: errorName(error) });
        }
      }
      try {
        await this.parts.wait(retryMs, this.stopping.signal);
      } catch {
        return false; // stopped while waiting
      }
      retryMs = Math.min(retryMs * 2, SEED_RETRY_MAX_MS);
    }
    return false;
  }
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'unknown';
}

function untilReady(redis: Redis, signal: AbortSignal): Promise<void> {
  if (redis.status === 'ready') return Promise.resolve();
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      redis.off('ready', onReady);
      reject(signal.reason);
    };
    const onReady = () => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    };
    redis.once('ready', onReady);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** An unref'd wait, so a pending retry never holds the process open at shutdown. */
const unrefWait = (ms: number, signal: AbortSignal) => delay(ms, undefined, { signal, ref: false });

/**
 * Builds the store, the signer provider for `FACILITATOR_SIGNING_MODE` and the pool. No I/O happens
 * until `start`, except that the Redis client begins connecting in the background.
 */
export function createChannelRuntime(
  config: FacilitatorConfig,
  log: Logger,
  deps: ChannelRuntimeDeps = {},
): ChannelRuntime {
  const { storeUrl, storeCommandTimeoutMs, cooldownMs, unknownMarginMs } = config.channelPool;
  // Before any client exists, so a configuration the pool cannot serve leaks no connection.
  const { provider, seeds } = channelSources(config, log, deps.kms);
  let store = deps.store;
  let close = async () => {};
  let connected = async (_signal: AbortSignal) => {};
  if (!store) {
    const redis = createChannelStoreClient(storeUrl, {
      commandTimeoutMs: storeCommandTimeoutMs,
      log,
    });
    store = new RedisLeaseStore(redis, { log });
    close = async () => {
      await redis.quit().catch(() => redis.disconnect());
    };
    connected = (signal) => untilReady(redis, signal);
  }
  const pool = new ChannelPool({
    store,
    signers: withSignerCache(provider),
    policy: { cooldownMs, unknownMarginMs },
    log,
  });
  const wait = deps.wait ?? unrefWait;
  return new Runtime({ pool, store, seeds, log, close, wait, connected });
}
