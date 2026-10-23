import type { SettleResponse } from '@x402/core/types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  SettlementCoordinator,
  settlementKey,
} from '../src/modules/x402/services/engine/settlement-coordinator.js';

const settled = (transaction: string): SettleResponse => ({
  success: true,
  transaction,
  network: 'stellar:testnet',
});

afterEach(() => {
  vi.useRealTimers();
});

describe('SettlementCoordinator', () => {
  it('builds the same key regardless of object key ordering', () => {
    expect(settlementKey({ b: 2, a: { d: 4, c: 3 } })).toBe(
      settlementKey({ a: { c: 3, d: 4 }, b: 2 }),
    );
  });

  it('does not cache failed settlement responses', async () => {
    const coordinator = new SettlementCoordinator(1_000, 10);
    const operation = vi.fn(async () => ({
      success: false as const,
      errorReason: 'insufficient_funds',
      transaction: '',
      network: 'stellar:testnet',
    }));
    await coordinator.run('key', operation);
    await coordinator.run('key', operation);
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it('runs the operation again once the cached result has expired', async () => {
    vi.useFakeTimers({ now: 0 });
    const coordinator = new SettlementCoordinator(1_000, 10);
    const operation = vi
      .fn<() => Promise<SettleResponse>>()
      .mockResolvedValueOnce(settled('first'))
      .mockResolvedValueOnce(settled('second'));
    await coordinator.run('key', operation);

    vi.setSystemTime(999);
    expect(await coordinator.run('key', operation)).toEqual(settled('first'));
    vi.setSystemTime(1_000);
    expect(await coordinator.run('key', operation)).toEqual(settled('second'));
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it('evicts the oldest result when the cache is full, and keeps the newer ones', async () => {
    const coordinator = new SettlementCoordinator(60_000, 2);
    const operations = ['a', 'b', 'c'].map((key) => vi.fn(async () => settled(key)));
    for (const [index, key] of ['a', 'b', 'c'].entries()) {
      await coordinator.run(key, operations[index]!);
    }

    await coordinator.run('a', operations[0]!);
    await coordinator.run('c', operations[2]!);

    expect(operations[0]).toHaveBeenCalledTimes(2);
    expect(operations[2]).toHaveBeenCalledOnce();
  });
});
