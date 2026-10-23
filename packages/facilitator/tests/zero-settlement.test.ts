import { randomBytes } from 'node:crypto';
import { Keypair, StrKey } from '@stellar/stellar-sdk';
import type { PaymentPayload, PaymentRequirements } from '@x402/core/types';
import { createEd25519Signer } from '@x402/stellar';
import { ExactStellarScheme } from '@x402/stellar/exact/facilitator';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SettlementContext,
  SettlementContexts,
} from '../src/modules/x402/services/channels/settlement-context.js';
import { ExactChannelScheme } from '../src/modules/x402/services/schemes/exact/exact-channel-scheme.js';
import { UptoStellarScheme } from '../src/modules/x402/services/schemes/upto/upto-stellar.scheme.js';
import { fakeRpc, simulationFailure, simulationSuccess, type FakeRpc } from './fake-rpc.js';
import { asset, exactPaymentXdr, payTo, uptoPaymentXdr } from './settlement-fixtures.js';

const kernel = StrKey.encodeContract(randomBytes(32));
const authorization = Keypair.random();
const facilitator = authorization.publicKey();
const buyer = Keypair.random().publicKey();

let rpc: FakeRpc;
let contexts: SettlementContexts;
/** Leases taken by the scheme under test; a zero settlement must take none. */
let acquire: ReturnType<typeof vi.fn>;

beforeEach(() => {
  rpc = fakeRpc();
  contexts = new SettlementContexts();
  acquire = vi.fn(async () => {
    throw new Error('a zero settlement must not lease a channel');
  });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** Runs `settle` inside a settlement context that records every lease attempt. */
function settleIn<T>(settle: () => Promise<T>): Promise<T> {
  const context = new SettlementContext({
    acquire,
  });
  return contexts.run(context, settle);
}

describe('zero upto settlement', () => {
  const maximum: PaymentRequirements = {
    scheme: 'upto',
    network: 'stellar:testnet',
    asset,
    payTo,
    amount: '10000',
    maxTimeoutSeconds: 60,
    extra: { areFeesSponsored: true, settlementContract: kernel, facilitator },
  };
  const zero = { ...maximum, amount: '0' };

  function scheme(): UptoStellarScheme {
    return new UptoStellarScheme(kernel, {
      maxResourceFeeStroops: 60_000,
      rpcConfig: { url: 'http://127.0.0.1:1' },
      contexts,
      authorizationSigner: createEd25519Signer(authorization.secret()),
      feeBumpSigner: createEd25519Signer(Keypair.random().secret()),
    });
  }

  function payment(terms: { payTo?: string } = {}): PaymentPayload {
    const transaction = uptoPaymentXdr(kernel, facilitator, {
      source: facilitator,
      terms: { payer: buyer, ...(terms.payTo ? { payTo: terms.payTo } : {}) },
    });
    return { x402Version: 2, accepted: maximum, payload: { transaction } };
  }

  it('answers a verified authorization as settled for nothing, without leasing or sending', async () => {
    const result = await settleIn(() => scheme().settle(payment(), zero));

    expect(result).toEqual({
      success: true,
      network: 'stellar:testnet',
      transaction: '',
      amount: '0',
      payer: buyer,
    });
    expect(rpc.simulateTransaction).toHaveBeenCalledTimes(1);
    expect(acquire).not.toHaveBeenCalled();
  });

  it('refuses an authorization whose simulation fails, with its reason', async () => {
    rpc.simulation = simulationFailure();

    const result = await settleIn(() => scheme().settle(payment(), zero));

    expect(result).toMatchObject({
      success: false,
      network: 'stellar:testnet',
      transaction: '',
      errorReason: 'invalid_upto_stellar_payload_simulation_failed',
    });
    expect(acquire).not.toHaveBeenCalled();
  });

  it('refuses an authorization for another payee, with its reason', async () => {
    const other = Keypair.random().publicKey();

    const result = await settleIn(() => scheme().settle(payment({ payTo: other }), zero));

    expect(result).toMatchObject({
      success: false,
      errorReason: 'invalid_upto_stellar_payload_terms',
    });
    expect(acquire).not.toHaveBeenCalled();
  });

  it('refuses undecodable XDR as malformed before leasing', async () => {
    const malformed = { ...payment(), payload: { transaction: 'not-valid-xdr' } };

    const result = await settleIn(() => scheme().settle(malformed, zero));

    expect(result).toMatchObject({
      success: false,
      errorReason: 'invalid_upto_stellar_payload_malformed',
      transaction: '',
    });
    expect(acquire).not.toHaveBeenCalled();
  });
});

describe('zero exact settlement', () => {
  const zero: PaymentRequirements = {
    scheme: 'exact',
    network: 'stellar:testnet',
    asset,
    payTo,
    amount: '0',
    maxTimeoutSeconds: 60,
    extra: { areFeesSponsored: true },
  };

  function scheme(): ExactChannelScheme {
    return new ExactChannelScheme({
      rpcConfig: { url: 'http://127.0.0.1:1' },
      maxResourceFeeStroops: 50_000,
      feeBumpSigner: createEd25519Signer(Keypair.random().secret()),
      contexts,
    });
  }

  function payment(amount: bigint): PaymentPayload {
    return {
      x402Version: 2,
      accepted: zero,
      payload: { transaction: exactPaymentXdr({ buyer, amount }) },
    };
  }

  it('answers a verified transfer of zero as settled, without leasing, signing or sending', async () => {
    rpc.simulation = simulationSuccess('100', [{ asset, from: buyer, to: payTo, amount: 0n }]);
    const upstreamSettle = vi.spyOn(ExactStellarScheme.prototype, 'settle');

    const result = await settleIn(() => scheme().settle(payment(0n), zero));

    expect(result).toEqual({
      success: true,
      network: 'stellar:testnet',
      transaction: '',
      amount: '0',
      payer: buyer,
    });
    expect(upstreamSettle).not.toHaveBeenCalled();
    expect(acquire).not.toHaveBeenCalled();
  });

  it('refuses a Buyer transfer of another amount with upstream’s reason', async () => {
    rpc.simulation = simulationSuccess('100', [{ asset, from: buyer, to: payTo, amount: 10_000n }]);

    const result = await settleIn(() => scheme().settle(payment(10_000n), zero));

    expect(result).toEqual({
      success: false,
      network: 'stellar:testnet',
      transaction: '',
      errorReason: 'invalid_exact_stellar_payload_wrong_amount',
    });
    expect(acquire).not.toHaveBeenCalled();
  });
});
