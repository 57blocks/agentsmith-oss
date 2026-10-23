import { randomBytes } from 'node:crypto';
import {
  Account,
  BASE_FEE,
  FeeBumpTransaction,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
} from '@stellar/stellar-sdk';
import { createEd25519Signer } from '@x402/stellar';
import type { PaymentPayload, PaymentRequirements } from '@x402/core/types';
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';
import {
  buildSettlementTransaction,
  ResourceFeeExceededError,
  settleResponseFor,
} from '../src/modules/x402/services/schemes/upto/upto-settlement.js';
import { checkUptoPayment } from '../src/modules/x402/services/schemes/upto/upto-verification.js';
import { UptoStellarScheme } from '../src/modules/x402/services/schemes/upto/upto-stellar.scheme.js';
import {
  SettlementContext,
  SettlementContexts,
} from '../src/modules/x402/services/channels/settlement-context.js';

const rpc = vi.hoisted(() => ({ sendTransaction: vi.fn(), getTransaction: vi.fn() }));

vi.mock(import('@x402/stellar'), async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, getRpcClient: () => rpc as never };
});
vi.mock(
  import('../src/modules/x402/services/schemes/upto/upto-verification.js'),
  async (importOriginal) => {
    const actual = await importOriginal();
    return { ...actual, checkUptoPayment: vi.fn(actual.checkUptoPayment) };
  },
);
vi.mock(
  import('../src/modules/x402/services/schemes/upto/upto-settlement.js'),
  async (importOriginal) => {
    const actual = await importOriginal();
    return { ...actual, buildSettlementTransaction: vi.fn(actual.buildSettlementTransaction) };
  },
);

const receipt = { network: 'stellar:testnet' as const, payer: 'GPAYER', amount: '10000' };

describe('upto settle response for a submission outcome', () => {
  it('reports an included, successful transaction as settled with its hash and amount', () => {
    expect(settleResponseFor({ kind: 'included', hash: 'h', successful: true }, receipt)).toEqual({
      success: true,
      network: 'stellar:testnet',
      transaction: 'h',
      payer: 'GPAYER',
      amount: '10000',
    });
  });

  it('reports an on-chain failure with its hash', () => {
    expect(
      settleResponseFor({ kind: 'included', hash: 'h', successful: false }, receipt),
    ).toMatchObject({
      success: false,
      transaction: 'h',
      errorReason: 'settle_upto_transaction_failed',
    });
  });

  it('reports an unknown outcome as pending with its hash', () => {
    expect(
      settleResponseFor({ kind: 'unknown', hash: 'h', validUntilMs: 1 }, receipt),
    ).toMatchObject({ success: false, transaction: 'h', errorReason: 'settlement_pending' });
  });

  it('reports a refused broadcast without a hash, so it is never reconciled as pending', () => {
    expect(
      settleResponseFor({ kind: 'rejected', hash: 'h', status: 'ERROR' }, receipt),
    ).toMatchObject({ success: false, transaction: '', errorReason: 'unexpected_settle_error' });
  });
});

describe('upto settlement through the transaction pipeline', () => {
  const contract = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM';
  const secret = () => Keypair.fromRawEd25519Seed(randomBytes(32)).secret();

  afterEach(() => {
    vi.mocked(checkUptoPayment).mockReset();
    vi.mocked(buildSettlementTransaction).mockReset();
    rpc.sendTransaction.mockReset();
    rpc.getTransaction.mockReset();
  });

  /** The leases handed out and the context of the last `settleWith`. */
  let settled: { context: SettlementContext; leases: { address: string; finish: Mock }[] };

  /**
   * Everything before signing is stubbed; signing, fee-bump and submission are real. The settlement
   * leases `channel` and never another.
   */
  function settleWith(
    channelOverrides: Partial<ReturnType<typeof createEd25519Signer>> = {},
    options: {
      buildError?: Error;
      log?: { info: Mock; warn: Mock; error: Mock };
    } = {},
  ) {
    const channel = { ...createEd25519Signer(secret()), ...channelOverrides };
    const leases = [channel].map((signer) => ({
      address: signer.address,
      signer,
      finish: vi.fn(async () => {}),
    }));
    let leased = 0;
    const context = new SettlementContext({
      acquire: async () => leases[leased++]!,
    });
    const contexts = new SettlementContexts();
    settled = { context, leases };
    const feePayer = createEd25519Signer(secret());
    const unsigned = new TransactionBuilder(new Account(channel.address, '1'), {
      fee: BASE_FEE,
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(Operation.bumpSequence({ bumpTo: '2' }))
      .setTimeout(60)
      .build();
    vi.mocked(checkUptoPayment).mockResolvedValueOnce({
      response: { isValid: true },
      transaction: unsigned,
      simulation: {} as never,
      payer: Keypair.random().publicKey(),
    });
    if (options.buildError) {
      vi.mocked(buildSettlementTransaction).mockRejectedValueOnce(options.buildError);
    } else {
      vi.mocked(buildSettlementTransaction).mockResolvedValue(unsigned);
    }
    const scheme = new UptoStellarScheme(contract, {
      maxResourceFeeStroops: 60_000,
      authorizationSigner: createEd25519Signer(secret()),
      contexts,
      feeBumpSigner: feePayer,
      log: options.log,
    });
    const requirements = {
      scheme: 'upto',
      network: 'stellar:testnet',
      amount: '10000',
      asset: contract,
      payTo: channel.address,
      maxTimeoutSeconds: 60,
      extra: { settlementContract: contract },
    } as PaymentRequirements;
    const payload = { x402Version: 2, accepted: requirements, payload: {} } as PaymentPayload;
    return contexts.run(context, () => scheme.settle(payload, requirements));
  }

  it('settles a confirmed transaction under the hash it computed before sending', async () => {
    rpc.sendTransaction.mockResolvedValueOnce({ status: 'PENDING' });
    rpc.getTransaction.mockResolvedValueOnce({ status: 'SUCCESS' });

    const result = await settleWith();

    const sent = rpc.sendTransaction.mock.calls[0]![0] as FeeBumpTransaction;
    expect(sent).toBeInstanceOf(FeeBumpTransaction);
    expect(result).toMatchObject({ success: true, transaction: sent.hash().toString('hex') });
  });

  it('reports a send that throws as pending with the hash, so the engine can reconcile it', async () => {
    rpc.sendTransaction.mockRejectedValueOnce(new Error('ECONNRESET'));

    const result = await settleWith();

    const sent = rpc.sendTransaction.mock.calls[0]![0] as FeeBumpTransaction;
    expect(result).toMatchObject({
      success: false,
      errorReason: 'settlement_pending',
      transaction: sent.hash().toString('hex'),
    });
  });

  it('reports a channel signer that throws as a signing failure, without sending', async () => {
    const result = await settleWith({
      signTransaction: async () => {
        throw new Error('socket hang up');
      },
    });

    expect(result).toMatchObject({
      success: false,
      errorReason: 'settle_upto_signing_failed',
      transaction: '',
    });
    expect(rpc.sendTransaction).not.toHaveBeenCalled();
    expect(settled.context.outcome).toEqual({ kind: 'not-sent' });
  });

  it('reports a settlement it could not build as build-failed, logs why, and sends nothing', async () => {
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const buildError = new Error('actual amount simulation failed: HostError');

    const result = await settleWith({}, { buildError, log });

    expect(result).toMatchObject({
      success: false,
      errorReason: 'settle_upto_transaction_build_failed',
      transaction: '',
    });
    expect(rpc.sendTransaction).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith('upto_settlement_build_failed', {
      channel: expect.stringMatching(/^G/),
      errorName: 'Error',
      errorMessage: buildError.message,
    });
  });

  it('reports a settlement over the resource fee ceiling with the fee reason, releasing its channel', async () => {
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const buildError = new ResourceFeeExceededError(
      'actual amount resource fee 60001 stroops exceeds ceiling 60000 stroops',
    );

    const result = await settleWith({}, { buildError, log });

    expect(result).toMatchObject({
      success: false,
      errorReason: 'invalid_upto_stellar_payload_fee_exceeds_maximum',
      transaction: '',
    });
    expect(rpc.sendTransaction).not.toHaveBeenCalled();
    expect(settled.context.outcome).toEqual({ kind: 'not-sent' });
    expect(log.warn).toHaveBeenCalledWith('upto_settlement_build_failed', {
      channel: expect.stringMatching(/^G/),
      errorName: 'ResourceFeeExceededError',
      errorMessage: buildError.message,
    });
  });

  it('reports a refused broadcast as unexpected_settle_error without a hash, on its one channel', async () => {
    rpc.sendTransaction.mockResolvedValueOnce({ status: 'ERROR' });

    const result = await settleWith();

    expect(result).toMatchObject({
      success: false,
      errorReason: 'unexpected_settle_error',
      transaction: '',
    });
    expect(rpc.getTransaction).not.toHaveBeenCalled();
    expect(settled.context.outcome).toEqual({
      kind: 'rejected',
      hash: expect.any(String),
      status: 'ERROR',
    });
    expect(rpc.sendTransaction).toHaveBeenCalledOnce();
    expect(settled.context.lease?.address).toBe(settled.leases[0]!.address);
  });
});
