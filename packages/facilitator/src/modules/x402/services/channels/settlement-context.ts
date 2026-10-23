import { AsyncLocalStorage } from 'node:async_hooks';
import type { Lease } from '../../../channels/core/channel-pool.js';
import type { SubmissionOutcome } from '../../../channels/core/transaction-pipeline.js';

/** What the engine supplies to one settlement: how to lease its channel. */
export interface SettlementChannelSource {
  /** Throws `ChannelsBusyError` or `ChannelStoreUnavailableError`; nothing is leased then. */
  acquire(): Promise<Lease>;
}

/**
 * One settlement's channel state. A scheme leases through it, marks the channel as selected once
 * its sequence may be consumed, and reports the outcome; the engine finishes the lease it holds at
 * the end.
 */
export class SettlementContext {
  lease?: Lease;
  /** Set once a scheme picks the leased channel to sign; from then on its sequence may be used. */
  selectedForSigning = false;
  outcome?: SubmissionOutcome;
  /** Time spent waiting for the lease; kept by the engine. */
  acquireWaitMs = 0;

  constructor(private readonly source: SettlementChannelSource) {}

  async acquire(): Promise<Lease> {
    this.lease = await this.source.acquire();
    this.selectedForSigning = false;
    this.outcome = undefined;
    return this.lease;
  }
}

/** Hands each running settlement its context across the schemes' async calls. */
export class SettlementContexts {
  private readonly current = new AsyncLocalStorage<SettlementContext>();

  run<T>(context: SettlementContext, operation: () => Promise<T>): Promise<T> {
    return this.current.run(context, operation);
  }

  /** The calling settlement's context; throws outside one, which is a wiring bug. */
  get(): SettlementContext {
    const context = this.current.getStore();
    if (!context) throw new Error('No settlement context');
    return context;
  }

  /** Upstream `exact`'s `selectSigner` hook: the channel leased to the calling settlement. */
  readonly selectSigner = (addresses: readonly string[]): string => {
    const lease = this.current.getStore()?.lease;
    if (!lease || !addresses.includes(lease.address)) {
      throw new Error('No leased channel for settlement');
    }
    this.get().selectedForSigning = true;
    return lease.address;
  };
}
