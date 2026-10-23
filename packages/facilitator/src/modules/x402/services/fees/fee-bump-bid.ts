import type { Logger } from '../../../../common/logger.js';
import { systemClock, type Clock } from '../../../channels/core/channel-pool.js';

/** The network's minimum inclusion fee per operation; every inner transaction bids it. */
export const MIN_INCLUSION_FEE_STROOPS = 100;

const REFRESH_MS = 30_000;
const READ_TIMEOUT_MS = 2_000;

/** The bid for a recent median inclusion fee: `ceil(median × multiplier)`, within [100, cap]. */
export function bidFromMedian(
  medianStroops: number,
  multiplier: number,
  capStroops: number,
): number {
  const bid = Math.ceil(medianStroops * multiplier);
  return Math.min(capStroops, Math.max(MIN_INCLUSION_FEE_STROOPS, bid));
}

/** `rpc.Server` satisfies it; only the Soroban median is read. */
export interface FeeStatsSource {
  getFeeStats(): Promise<{ sorobanInclusionFee: { p50: string } }>;
}

export interface FeeBumpBidDeps {
  stats: FeeStatsSource;
  multiplier: number;
  capStroops: number;
  log: Logger;
  clock?: Pick<Clock, 'now'>;
}

class FeeStatsTimeoutError extends Error {
  override name = 'FeeStatsTimeoutError';
}

/** `read`'s answer, or `FeeStatsTimeoutError` after `ms`; the timer is cleared either way. */
async function withinMs<T>(read: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new FeeStatsTimeoutError(`no fee statistics in ${ms} ms`)), ms);
    // Never holds the process open at shutdown.
    timer.unref();
  });
  try {
    return await Promise.race([read, expired]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The fee-bump bid per operation, in stroops, from the network's recent median Soroban inclusion
 * fee. A bid read under 30 s ago is used as is; an older one is refreshed first, waiting at most
 * 2 s, and a failed or slow read keeps the last bid.
 */
export class FeeBumpBid {
  private bidStroops?: number;
  private lastReadMs?: number;
  private reading?: Promise<void>;
  private readonly clock: Pick<Clock, 'now'>;

  constructor(private readonly deps: FeeBumpBidDeps) {
    this.clock = deps.clock ?? systemClock;
  }

  /**
   * Never throws. Before any read has succeeded, it is half the cap, but never below the network
   * minimum.
   */
  async currentStroops(): Promise<number> {
    const now = this.clock.now();
    // A read records its start, so callers while it runs see a fresh time and wait on it instead.
    if (this.lastReadMs === undefined || now - this.lastReadMs >= REFRESH_MS) {
      this.lastReadMs = now;
      this.reading = this.read().finally(() => {
        this.reading = undefined;
      });
    }
    if (this.reading) await this.reading;
    return this.bidStroops ?? this.fallbackStroops();
  }

  private fallbackStroops(): number {
    return Math.max(MIN_INCLUSION_FEE_STROOPS, Math.floor(this.deps.capStroops / 2));
  }

  /** Bounded by the read timeout, so a hung RPC can never stop later refreshes. Never rejects. */
  private async read(): Promise<void> {
    const { stats, multiplier, capStroops, log } = this.deps;
    try {
      const { sorobanInclusionFee } = await withinMs(stats.getFeeStats(), READ_TIMEOUT_MS);
      const medianStroops = Number(sorobanInclusionFee.p50);
      if (!Number.isSafeInteger(medianStroops) || medianStroops < 0) {
        throw new TypeError('fee statistics have no usable median');
      }
      const bidStroops = bidFromMedian(medianStroops, multiplier, capStroops);
      if (bidStroops !== this.bidStroops) {
        log.info('fee_bump_bid_updated', { medianStroops, bidStroops });
      }
      this.bidStroops = bidStroops;
    } catch (error) {
      // The last bid stays; a settlement is never failed for pricing.
      log.warn('fee_bump_bid_stats_failed', {
        errorName: error instanceof Error ? error.name : 'unknown',
        bidStroops: this.bidStroops ?? this.fallbackStroops(),
      });
    }
  }
}
