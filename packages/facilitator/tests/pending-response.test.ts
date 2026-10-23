import { randomBytes } from 'node:crypto';
import { Keypair } from '@stellar/stellar-sdk';
import type { PaymentPayload, PaymentRequirements, SettleResponse } from '@x402/core/types';
import { ExactStellarScheme } from '@x402/stellar/exact/facilitator';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config/facilitator.config.js';
import { createStellarPaymentEngine } from '../src/modules/x402/services/engine/payment-engine.js';
import { UptoStellarScheme } from '../src/modules/x402/services/schemes/upto/upto-stellar.scheme.js';
import type { SettlementContexts } from '../src/modules/x402/services/channels/settlement-context.js';
import { fakeChannelPool } from './fake-lease-store.js';
import { TEST_DATABASE_URL } from './test-env.js';
import { journalWithoutDatabase } from './test-journal.js';

const rpc = vi.hoisted(() => ({ getTransaction: vi.fn() }));

vi.mock('@x402/stellar', async (importOriginal) => {
  const original = (await importOriginal()) as Record<string, unknown>;
  return { ...original, getRpcClient: () => rpc };
});

const requirements = {
  scheme: 'exact',
  network: 'stellar:testnet',
  amount: '40000',
  asset: 'C_TOKEN',
  payTo: 'G_PAYEE',
  maxTimeoutSeconds: 60,
  extra: { areFeesSponsored: true },
} as PaymentRequirements;

function payment(scheme: 'exact' | 'upto'): {
  payload: PaymentPayload;
  terms: PaymentRequirements;
} {
  const terms = { ...requirements, scheme };
  return {
    payload: { x402Version: 2, accepted: terms, payload: { transaction: 'signed-xdr' } },
    terms,
  };
}

async function engine() {
  const channel = Keypair.fromRawEd25519Seed(randomBytes(32)).secret();
  const config = loadConfig({
    DATABASE_URL: TEST_DATABASE_URL,
    CHANNEL_STORE_URL: 'redis://127.0.0.1:6379',
    FACILITATOR_STELLAR_PRIVATE_KEY: Keypair.fromRawEd25519Seed(randomBytes(32)).secret(),
    FACILITATOR_STELLAR_FEE_BUMP_SECRET: Keypair.fromRawEd25519Seed(randomBytes(32)).secret(),
    FACILITATOR_STELLAR_CHANNEL_SECRETS: channel,
    FACILITATOR_API_KEY: 'test-only-token',
    X402_UPTO_KERNEL_CONTRACT: Keypair.fromRawEd25519Seed(randomBytes(32)).publicKey(),
  });
  const { pool, clock } = fakeChannelPool([channel]);
  return createStellarPaymentEngine(
    config,
    { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    { pool, clock, journal: journalWithoutDatabase() },
  );
}

/**
 * Stubs a scheme's settlement after it has leased and selected its channel, and counts the
 * settlements that got that far.
 */
function settlesAfterLeasing(scheme: 'exact' | 'upto', result: SettleResponse) {
  const leased = { count: 0 };
  if (scheme === 'exact') {
    vi.spyOn(ExactStellarScheme.prototype, 'settle').mockImplementation(async function () {
      const upstream = this as unknown as {
        signingAddresses: ReadonlySet<string>;
        selectSigner(addresses: string[]): string;
      };
      upstream.selectSigner([...upstream.signingAddresses]);
      leased.count += 1;
      return result;
    });
  } else {
    vi.spyOn(UptoStellarScheme.prototype, 'settle').mockImplementation(async function () {
      const context = (this as unknown as { contexts: SettlementContexts }).contexts.get();
      await context.acquire();
      context.selectedForSigning = true;
      leased.count += 1;
      return result;
    });
  }
  return leased;
}

afterEach(() => {
  vi.restoreAllMocks();
  rpc.getTransaction.mockReset();
});

describe('unconfirmed settlement responses', () => {
  it('answers a pending broadcast with its hash, without reading the chain again', async () => {
    settlesAfterLeasing('upto', {
      success: false,
      errorReason: 'settle_upto_transaction_pending',
      transaction: 'tx-hash',
      network: 'stellar:testnet',
    });
    const facilitator = await engine();
    const { payload, terms } = payment('upto');

    expect(await facilitator.settle(payload, terms)).toMatchObject({
      success: false,
      errorReason: 'settlement_pending',
      transaction: 'tx-hash',
    });
    expect(rpc.getTransaction).not.toHaveBeenCalled();
  });

  it('still answers a transaction read as failed on chain as a final failure', async () => {
    settlesAfterLeasing('exact', {
      success: false,
      errorReason: 'settle_exact_stellar_transaction_failed',
      transaction: 'failed-hash',
      network: 'stellar:testnet',
    });
    rpc.getTransaction.mockResolvedValue({ status: 'FAILED' });
    const facilitator = await engine();
    const { payload, terms } = payment('exact');

    expect(await facilitator.settle(payload, terms)).toMatchObject({
      success: false,
      errorReason: 'invalid_transaction_state',
      transaction: 'failed-hash',
    });
    expect(rpc.getTransaction).toHaveBeenCalledTimes(1);
  });

  it('answers a transaction read as successful on chain as settled, with its amount', async () => {
    settlesAfterLeasing('exact', {
      success: false,
      errorReason: 'settle_exact_stellar_transaction_failed',
      transaction: 'landed-hash',
      network: 'stellar:testnet',
    });
    rpc.getTransaction.mockResolvedValue({ status: 'SUCCESS' });
    const facilitator = await engine();
    const { payload, terms } = payment('exact');

    expect(await facilitator.settle(payload, terms)).toMatchObject({
      success: true,
      transaction: 'landed-hash',
      amount: '40000',
    });
  });

  it('answers an error after channel selection as pending_unknown', async () => {
    vi.spyOn(UptoStellarScheme.prototype, 'settle').mockImplementation(async function () {
      const context = (this as unknown as { contexts: SettlementContexts }).contexts.get();
      await context.acquire();
      context.selectedForSigning = true;
      throw new Error('connection reset after send');
    });
    const facilitator = await engine();
    const { payload, terms } = payment('upto');

    expect(await facilitator.settle(payload, terms)).toMatchObject({
      success: false,
      errorReason: 'settlement_pending_unknown',
    });
  });
});
