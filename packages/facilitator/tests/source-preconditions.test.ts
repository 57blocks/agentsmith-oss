import { Keypair } from '@stellar/stellar-sdk';
import type { PaymentPayload, PaymentRequirements } from '@x402/core/types';
import { createEd25519Signer } from '@x402/stellar';
import { ExactStellarScheme } from '@x402/stellar/exact/facilitator';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SettlementContexts } from '../src/modules/x402/services/channels/settlement-context.js';
import { ExactChannelScheme } from '../src/modules/x402/services/schemes/exact/exact-channel-scheme.js';
import { checkUptoPayment } from '../src/modules/x402/services/schemes/upto/upto-verification.js';
import { asset, exactPaymentXdr, payTo, type BuyerPreconditions } from './settlement-fixtures.js';

const preconditions: [string, BuyerPreconditions][] = [
  ['ledger bounds', { ledgerbounds: { minLedger: 0, maxLedger: 5_000 } }],
  ['a minimum sequence', { minAccountSequence: '7' }],
  ['a minimum sequence age', { minAccountSequenceAge: 30n }],
  ['a minimum sequence ledger gap', { minAccountSequenceLedgerGap: 2 }],
  ['an extra signer', { extraSigners: [Keypair.random().publicKey()] }],
];

function requirementsFor(scheme: 'exact' | 'upto'): PaymentRequirements {
  return {
    scheme,
    network: 'stellar:testnet',
    asset,
    payTo,
    amount: '10000',
    maxTimeoutSeconds: 60,
    extra: { areFeesSponsored: true },
  };
}

function payloadWith(requirements: PaymentRequirements, set: BuyerPreconditions): PaymentPayload {
  return {
    x402Version: 2,
    accepted: requirements,
    payload: { transaction: exactPaymentXdr({}, set) },
  };
}

function exactScheme(contexts = new SettlementContexts()): ExactChannelScheme {
  return new ExactChannelScheme({
    rpcConfig: { url: 'http://127.0.0.1:1' },
    maxResourceFeeStroops: 1_000_000,
    feeBumpSigner: createEd25519Signer(Keypair.random().secret()),
    contexts,
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Buyer transaction preconditions', () => {
  it.each(preconditions)(
    'exact verification rejects %s without verifying upstream',
    async (_, set) => {
      const upstream = vi.spyOn(ExactStellarScheme.prototype, 'verify');
      const requirements = requirementsFor('exact');

      const result = await exactScheme().verify(payloadWith(requirements, set), requirements);

      expect(result).toEqual({
        isValid: false,
        invalidReason: 'invalid_exact_stellar_payload_preconditions',
      });
      expect(upstream).not.toHaveBeenCalled();
    },
  );

  it.each(preconditions)('exact settlement rejects %s before leasing a channel', async (_, set) => {
    const contexts = new SettlementContexts();
    const lookup = vi.spyOn(contexts, 'get');
    const requirements = requirementsFor('exact');

    const result = await exactScheme(contexts).settle(payloadWith(requirements, set), requirements);

    expect(result).toEqual({
      success: false,
      network: 'stellar:testnet',
      transaction: '',
      errorReason: 'invalid_exact_stellar_payload_preconditions',
    });
    expect(lookup).not.toHaveBeenCalled();
  });

  it('exact verification passes a transaction with only time bounds to upstream', async () => {
    const upstream = vi
      .spyOn(ExactStellarScheme.prototype, 'verify')
      .mockResolvedValue({ isValid: true, payer: 'G_BUYER' });
    const requirements = requirementsFor('exact');
    const payload = payloadWith(requirements, {});

    const result = await exactScheme().verify(payload, requirements);

    expect(result).toEqual({ isValid: true, payer: 'G_BUYER' });
    expect(upstream).toHaveBeenCalledExactlyOnceWith(payload, requirements);
  });

  it.each(preconditions)('upto verification rejects %s', async (_, set) => {
    const requirements = requirementsFor('upto');
    const context = {
      settlementContract: asset,
      authorizationAddress: Keypair.random().publicKey(),
      maxResourceFeeStroops: 1_000_000,
    };

    for (const phase of ['verify', 'settle'] as const) {
      const { response } = await checkUptoPayment(
        context,
        payloadWith(requirements, set),
        requirements,
        phase,
      );
      expect(response).toMatchObject({
        isValid: false,
        invalidReason: 'invalid_upto_stellar_payload_preconditions',
      });
    }
  });
});
