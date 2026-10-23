import type { SettleResponse } from '@x402/core/types';
import { describe, expect, it, vi } from 'vitest';
import { classifyExactResult } from '../src/modules/x402/services/schemes/exact/exact-outcome.js';

const NOW = 1_000_000;

function result(errorReason: string | undefined, transaction = ''): SettleResponse {
  return { success: !errorReason, network: 'stellar:testnet', transaction, errorReason };
}

function classify(
  response: SettleResponse,
  options: { selected?: boolean; status?: string | Error } = {},
) {
  const getTransaction = vi.fn(async () => {
    if (options.status instanceof Error) throw options.status;
    return { status: options.status ?? 'NOT_FOUND' };
  });
  const outcome = classifyExactResult(response, options.selected ?? true, {
    getTransaction,
    nowMs: NOW,
    maxTimeoutSeconds: 60,
  });
  return { outcome, getTransaction };
}

describe('classifying an upstream exact settlement', () => {
  it('is not-sent when the channel was never selected, whatever the reason', async () => {
    const { outcome } = classify(result('unexpected_settle_error', 'h'), { selected: false });
    expect(await outcome).toEqual({ kind: 'not-sent' });
  });

  it.each([
    'settle_exact_stellar_signer_selection_failed',
    'settle_exact_stellar_transaction_signing_failed',
    'settle_exact_stellar_fee_bump_signing_failed',
  ])('is not-sent after %s', async (reason) => {
    expect(await classify(result(reason)).outcome).toEqual({ kind: 'not-sent' });
  });

  it('is rejected, without a hash, when the node refused the broadcast', async () => {
    const { outcome } = classify(result('settle_exact_stellar_transaction_submission_failed'));
    expect(await outcome).toEqual({
      kind: 'rejected',
      status: 'settle_exact_stellar_transaction_submission_failed',
    });
  });

  it('is included and successful for a settled payment', async () => {
    expect(await classify(result(undefined, 'h')).outcome).toEqual({
      kind: 'included',
      hash: 'h',
      successful: true,
    });
  });

  it('reads the hash once and is included when Stellar reports it failed', async () => {
    const { outcome, getTransaction } = classify(
      result('settle_exact_stellar_transaction_failed', 'h'),
      { status: 'FAILED' },
    );
    expect(await outcome).toEqual({ kind: 'included', hash: 'h', successful: false });
    expect(getTransaction).toHaveBeenCalledOnce();
  });

  it('reads the hash once and is included and successful when Stellar reports it succeeded', async () => {
    const { outcome, getTransaction } = classify(
      result('settle_exact_stellar_transaction_failed', 'h'),
      { status: 'SUCCESS' },
    );
    expect(await outcome).toEqual({ kind: 'included', hash: 'h', successful: true });
    expect(getTransaction).toHaveBeenCalledOnce();
  });

  it.each([
    'settle_exact_stellar_transaction_submission_failed',
    'settle_exact_stellar_fee_bump_signing_failed',
  ])('is unknown, without reading, when %s comes with a hash', async (reason) => {
    const { outcome, getTransaction } = classify(result(reason, 'h'));
    expect(await outcome).toEqual({ kind: 'unknown', hash: 'h', validUntilMs: NOW + 60_000 });
    expect(getTransaction).not.toHaveBeenCalled();
  });

  it.each([['NOT_FOUND'], [new Error('timeout')]])(
    'is unknown until the timeout when the hash reads %s',
    async (status) => {
      const { outcome } = classify(result('settle_exact_stellar_transaction_failed', 'h'), {
        status,
      });
      expect(await outcome).toEqual({ kind: 'unknown', hash: 'h', validUntilMs: NOW + 60_000 });
    },
  );

  it('is unknown, without reading anything, after an unexpected error once selected', async () => {
    const { outcome, getTransaction } = classify(result('unexpected_settle_error'));
    expect(await outcome).toEqual({
      kind: 'unknown',
      hash: undefined,
      validUntilMs: NOW + 60_000,
    });
    expect(getTransaction).not.toHaveBeenCalled();
  });
});
