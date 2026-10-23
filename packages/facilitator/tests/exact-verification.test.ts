import { randomBytes } from 'node:crypto';
import { Keypair, StrKey, xdr } from '@stellar/stellar-sdk';
import type { PaymentPayload, PaymentRequirements } from '@x402/core/types';
import { createEd25519Signer } from '@x402/stellar';
import { ExactStellarScheme } from '@x402/stellar/exact/facilitator';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SettlementContext,
  SettlementContexts,
} from '../src/modules/x402/services/channels/settlement-context.js';
import { ExactChannelScheme } from '../src/modules/x402/services/schemes/exact/exact-channel-scheme.js';
import { fakeRpc, simulationFailure, simulationSuccess, type FakeRpc } from './fake-rpc.js';
import { asset, exactPaymentXdr, payTo, type BuyerAuthorization } from './settlement-fixtures.js';

/** Below upstream's 50_000 default, so the ceiling tests fail if the option does not reach it. */
const MAX_FEE_STROOPS = 40_000;
/** Upstream adds its inner bid, kept at the minimum, to the resource fee in its ceiling check. */
const INCLUSION_FEE_STROOPS = 100;

const buyer = Keypair.random().publicKey();
const feePayer = createEd25519Signer(Keypair.random().secret());
const channel = createEd25519Signer(Keypair.random().secret());

const requirements: PaymentRequirements = {
  scheme: 'exact',
  network: 'stellar:testnet',
  asset,
  payTo,
  amount: '10000',
  maxTimeoutSeconds: 60,
  extra: { areFeesSponsored: true },
};

let rpc: FakeRpc;
let contexts: SettlementContexts;
let scheme: ExactChannelScheme;

beforeEach(() => {
  rpc = fakeRpc({ simulation: transferSimulated() });
  contexts = new SettlementContexts();
  scheme = new ExactChannelScheme({
    rpcConfig: { url: 'http://127.0.0.1:1' },
    maxResourceFeeStroops: MAX_FEE_STROOPS,
    feeBumpSigner: feePayer,
    contexts,
  });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** A simulation that moved `amount` from `from` to the payee in the asset. */
function transferSimulated(from = buyer, amount = 10_000n, minResourceFee = '100') {
  return simulationSuccess(minResourceFee, [{ asset, from, to: payTo, amount }]);
}

function payment(auth: BuyerAuthorization = {}): PaymentPayload {
  return {
    x402Version: 2,
    accepted: requirements,
    payload: { transaction: exactPaymentXdr({ buyer, ...auth }) },
  };
}

/**
 * Settles once with `leased` as the leased channel, so the scheme rebuilds upstream with it.
 * Upstream's own settlement is stubbed: only the lease matters here.
 */
async function leaseOnce(leased = channel): Promise<void> {
  vi.spyOn(ExactStellarScheme.prototype, 'settle').mockResolvedValueOnce({
    success: false,
    errorReason: 'stubbed',
    transaction: '',
    network: 'stellar:testnet',
  });
  const context = new SettlementContext({
    acquire: async () => ({ address: leased.address, signer: leased, finish: async () => {} }),
  });
  await contexts.run(context, () => scheme.settle(payment(), requirements));
}

const rejected = (invalidReason: string, payer?: string) => ({
  isValid: false,
  invalidReason,
  ...(payer ? { payer } : {}),
});

describe('exact verification of a valid payment', () => {
  it('accepts it with the Buyer as payer, simulating the Buyer transaction once', async () => {
    const pay = payment();

    expect(await scheme.verify(pay, requirements)).toEqual({ isValid: true, payer: buyer });
    expect(rpc.simulateTransaction).toHaveBeenCalledOnce();
    expect(rpc.simulateTransaction.mock.calls[0]![0].toXDR()).toBe(
      (pay.payload as { transaction: string }).transaction,
    );
  });

  it('accepts a resource fee exactly at the resource ceiling', async () => {
    rpc.simulation = transferSimulated(buyer, 10_000n, String(MAX_FEE_STROOPS));

    expect(await scheme.verify(payment(), requirements)).toEqual({ isValid: true, payer: buyer });
  });
});

describe('exact verification keeps facilitator accounts out of the payment', () => {
  it('rejects the fee payer as transaction source before any channel is leased', async () => {
    expect(await scheme.verify(payment({ source: feePayer.address }), requirements)).toEqual(
      rejected('invalid_exact_stellar_payload_unsafe_tx_or_op_source'),
    );
  });

  it('rejects the fee payer as transaction source after a channel is leased', async () => {
    await leaseOnce();

    expect(await scheme.verify(payment({ source: feePayer.address }), requirements)).toEqual(
      rejected('invalid_exact_stellar_payload_unsafe_tx_or_op_source'),
    );
  });

  it('rejects the fee payer as payer before any channel is leased', async () => {
    expect(await scheme.verify(payment({ buyer: feePayer.address }), requirements)).toEqual(
      rejected('invalid_exact_stellar_payload_facilitator_is_payer'),
    );
  });

  it('rejects the fee payer as payer after a channel is leased', async () => {
    await leaseOnce();

    expect(await scheme.verify(payment({ buyer: feePayer.address }), requirements)).toEqual(
      rejected('invalid_exact_stellar_payload_facilitator_is_payer'),
    );
  });

  it('rejects a channel this instance has leased as transaction source', async () => {
    await leaseOnce();

    expect(await scheme.verify(payment({ source: channel.address }), requirements)).toEqual(
      rejected('invalid_exact_stellar_payload_unsafe_tx_or_op_source'),
    );
  });

  // Only channels this process has leased reach upstream's safety set. Accepted behaviour: a Buyer
  // cannot sign as a channel, so the payment cannot move a channel's funds.
  it('accepts a pool channel this instance has not leased as transaction source', async () => {
    await leaseOnce();
    const unleased = Keypair.random().publicKey();

    expect(await scheme.verify(payment({ source: unleased }), requirements)).toEqual({
      isValid: true,
      payer: buyer,
    });
  });
});

describe('exact verification wiring to upstream', () => {
  it('refuses a resource fee one stroop above the configured resource ceiling', async () => {
    rpc.simulation = transferSimulated(buyer, 10_000n, String(MAX_FEE_STROOPS + 1));

    expect(await scheme.verify(payment(), requirements)).toEqual({
      isValid: false,
      invalidReason: 'invalid_exact_stellar_payload_fee_exceeds_maximum',
      payer: buyer,
      invalidMessage: `simulation-derived fee ${MAX_FEE_STROOPS + 1 + INCLUSION_FEE_STROOPS} stroops exceeds ceiling ${MAX_FEE_STROOPS + INCLUSION_FEE_STROOPS} stroops`,
    });
  });

  it('passes an undecodable transaction past the precondition gate for upstream to reject', async () => {
    const upstream = vi.spyOn(ExactStellarScheme.prototype, 'verify');
    const undecodable: PaymentPayload = {
      x402Version: 2,
      accepted: requirements,
      payload: { transaction: 'not-a-transaction' },
    };

    expect(await scheme.verify(undecodable, requirements)).toEqual(
      rejected('invalid_exact_stellar_payload_malformed'),
    );
    expect(upstream).toHaveBeenCalledWith(undecodable, requirements);
  });
});

describe('exact verification reaches upstream payment checks', () => {
  it('rejects a transfer of another amount', async () => {
    expect(await scheme.verify(payment({ amount: 9_999n }), requirements)).toEqual(
      rejected('invalid_exact_stellar_payload_wrong_amount', buyer),
    );
    expect(rpc.simulateTransaction).not.toHaveBeenCalled();
  });

  it('rejects a transfer to another payee', async () => {
    const elsewhere = { ...requirements, payTo: Keypair.random().publicKey() };
    const pay = { ...payment(), accepted: elsewhere };

    expect(await scheme.verify(pay, elsewhere)).toEqual(
      rejected('invalid_exact_stellar_payload_wrong_recipient', buyer),
    );
  });

  it('rejects a transfer of another asset', async () => {
    const otherAsset = {
      ...requirements,
      asset: StrKey.encodeContract(randomBytes(32)),
    };
    const pay = { ...payment(), accepted: otherAsset };

    expect(await scheme.verify(pay, otherAsset)).toEqual(
      rejected('invalid_exact_stellar_payload_wrong_asset'),
    );
  });

  it('rejects a payment whose Buyer authorization is unsigned', async () => {
    const unsigned = payment({ signature: xdr.ScVal.scvVoid() });

    expect(await scheme.verify(unsigned, requirements)).toEqual(
      rejected('invalid_exact_stellar_payload_missing_payer_signature', buyer),
    );
  });

  it('rejects a payment whose simulation fails', async () => {
    rpc.simulation = simulationFailure();

    expect(await scheme.verify(payment(), requirements)).toEqual(
      rejected('invalid_exact_stellar_payload_simulation_failed', buyer),
    );
  });
});
