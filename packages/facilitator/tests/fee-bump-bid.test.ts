import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  bidFromMedian,
  FeeBumpBid,
  type FeeStatsSource,
} from '../src/modules/x402/services/fees/fee-bump-bid.js';

const CAP = 2_000;

/** Fee statistics whose median is each value in turn; an Error is thrown instead of answered. */
function statsAnswering(...medians: (string | Error)[]) {
  const getFeeStats = vi.fn(async () => {
    const next = medians.shift() ?? '200';
    if (next instanceof Error) throw next;
    return { sorobanInclusionFee: { p50: next } };
  });
  return { getFeeStats } satisfies FeeStatsSource;
}

/** Fee statistics that never answer, like an RPC that accepted the connection and stalled. */
function statsHanging() {
  return { getFeeStats: vi.fn(() => new Promise<never>(() => {})) } satisfies FeeStatsSource;
}

function bidWith(stats: FeeStatsSource, capStroops = CAP) {
  const clock = { current: 1_000_000, now: () => clock.current };
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const bid = new FeeBumpBid({ stats, multiplier: 1.5, capStroops, log, clock });
  return { bid, clock, log };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('fee-bump bid from a median inclusion fee', () => {
  it.each([
    ['multiplies the median', 200, 300],
    ['rounds a fractional bid up', 201, 302],
    ['never bids below the network minimum', 10, 100],
    ['never bids above the cap', 5_000, CAP],
  ])('%s', (_, median, expected) => {
    expect(bidFromMedian(median, 1.5, CAP)).toBe(expected);
  });
});

describe('fee-bump bid over time', () => {
  it('reads the fee statistics before the first bid and bids from them', async () => {
    const { bid, log } = bidWith(statsAnswering('200'));

    expect(await bid.currentStroops()).toBe(300);
    expect(log.info.mock.calls).toEqual([
      ['fee_bump_bid_updated', { medianStroops: 200, bidStroops: 300 }],
    ]);
  });

  it('reuses a bid read under 30 seconds ago without reading again', async () => {
    const stats = statsAnswering('200', '400');
    const { bid, clock } = bidWith(stats);
    await bid.currentStroops();

    clock.current += 29_999;
    for (let i = 0; i < 5; i += 1) expect(await bid.currentStroops()).toBe(300);

    expect(stats.getFeeStats).toHaveBeenCalledOnce();
  });

  it('reads again before bidding once the last read is 30 seconds old', async () => {
    const stats = statsAnswering('200', '400');
    const { bid, clock } = bidWith(stats);
    await bid.currentStroops();

    clock.current += 30_000;

    expect(await bid.currentStroops()).toBe(600);
    expect(stats.getFeeStats).toHaveBeenCalledTimes(2);
  });

  it('shares one read between settlements that ask at the same time', async () => {
    const stats = statsAnswering('200');
    const { bid } = bidWith(stats);

    const bids = await Promise.all([bid.currentStroops(), bid.currentStroops()]);

    expect(bids).toEqual([300, 300]);
    expect(stats.getFeeStats).toHaveBeenCalledOnce();
  });

  it('keeps the last bid when a read fails, and logs the failure by name', async () => {
    const { bid, clock, log } = bidWith(statsAnswering('200', new TypeError('fetch failed')));
    await bid.currentStroops();
    clock.current += 30_000;

    expect(await bid.currentStroops()).toBe(300);
    expect(log.warn.mock.calls).toEqual([
      ['fee_bump_bid_stats_failed', { errorName: 'TypeError', bidStroops: 300 }],
    ]);
  });

  it('bids half the cap, rounded down, when the first read fails', async () => {
    const { bid, log } = bidWith(statsAnswering(new Error('timeout')), 1_999);

    expect(await bid.currentStroops()).toBe(999);
    expect(log.warn).toHaveBeenCalledWith('fee_bump_bid_stats_failed', {
      errorName: 'Error',
      bidStroops: 999,
    });
  });

  it('never falls back below the network minimum, whatever the cap', async () => {
    const { bid } = bidWith(statsAnswering(new Error('timeout')), 150);

    expect(await bid.currentStroops()).toBe(100);
  });

  it('waits at most 2 seconds for a read, then bids without it', async () => {
    vi.useFakeTimers();
    const { bid, log } = bidWith(statsHanging());

    const bidding = bid.currentStroops();
    await vi.advanceTimersByTimeAsync(2_000);

    expect(await bidding).toBe(1_000);
    expect(log.warn).toHaveBeenCalledWith('fee_bump_bid_stats_failed', {
      errorName: 'FeeStatsTimeoutError',
      bidStroops: 1_000,
    });
  });

  it('leaves no timer behind once a read answers in time', async () => {
    vi.useFakeTimers();
    const { bid } = bidWith(statsAnswering('200'));

    expect(await bid.currentStroops()).toBe(300);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('reads again 30 seconds after a read that never answered', async () => {
    vi.useFakeTimers();
    const stats = { getFeeStats: vi.fn() };
    stats.getFeeStats
      .mockImplementationOnce(() => new Promise<never>(() => {}))
      .mockResolvedValueOnce({ sorobanInclusionFee: { p50: '200' } });
    const { bid, clock } = bidWith(stats);
    const first = bid.currentStroops();
    await vi.advanceTimersByTimeAsync(2_000);
    await first;

    clock.current += 30_000;

    expect(await bid.currentStroops()).toBe(300);
    expect(stats.getFeeStats).toHaveBeenCalledTimes(2);
  });

  it.each(['n/a', '1.5', '-1'])('treats the median %j as a failed read', async (median) => {
    const { bid, log } = bidWith(statsAnswering(median));

    expect(await bid.currentStroops()).toBe(1_000);
    expect(log.warn).toHaveBeenCalledWith('fee_bump_bid_stats_failed', {
      errorName: 'TypeError',
      bidStroops: 1_000,
    });
  });

  it('logs nothing when a read leaves the bid unchanged', async () => {
    const { bid, clock, log } = bidWith(statsAnswering('200', '200'));
    await bid.currentStroops();
    clock.current += 30_000;
    await bid.currentStroops();

    expect(log.info).toHaveBeenCalledOnce();
  });
});
