import { randomBytes } from 'node:crypto';
import { Account, Keypair, Networks, StrKey, Transaction, xdr } from '@stellar/stellar-sdk';
import type { rpc } from '@stellar/stellar-sdk';
import type { PaymentRequirements } from '@x402/core/types';
import { createEd25519Signer } from '@x402/stellar';
import { describe, expect, it, vi } from 'vitest';
import {
  buildSettlementTransaction,
  ResourceFeeExceededError,
  type UptoSettlementContext,
} from '../src/modules/x402/services/schemes/upto/upto-settlement.js';
import { simulationSuccess } from './fake-rpc.js';
import { asset, payTo, uptoAuthEntry, uptoPaymentXdr } from './settlement-fixtures.js';

const MAX_RESOURCE_FEE_STROOPS = 40_000;
const kernel = StrKey.encodeContract(randomBytes(32));
const authorization = Keypair.random();
const buyer = Keypair.random().publicKey();
const channel = Keypair.random().publicKey();

const requirements: PaymentRequirements = {
  scheme: 'upto',
  network: 'stellar:testnet',
  asset,
  payTo,
  amount: '4000',
  maxTimeoutSeconds: 60,
  extra: { settlementContract: kernel, facilitator: authorization.publicKey() },
};

/**
 * The first simulation returns the facilitator's authorization entry to sign; the second, with
 * every entry in place, returns `resourceFee` as the settlement's resource fee.
 */
function contextWith(resourceFee: number): UptoSettlementContext {
  const generated: rpc.Api.SimulateTransactionResponse = {
    ...simulationSuccess(),
    result: {
      auth: [uptoAuthEntry(kernel, authorization.publicKey(), 2_000)],
      retval: xdr.ScVal.scvVoid(),
    },
  } as rpc.Api.SimulateTransactionResponse;
  const simulateTransaction = vi
    .fn()
    .mockResolvedValueOnce(generated)
    .mockResolvedValueOnce(simulationSuccess(String(resourceFee)));
  return {
    rpc: {
      getAccount: vi.fn(async () => new Account(channel, '41')),
      simulateTransaction,
    } as unknown as UptoSettlementContext['rpc'],
    networkPassphrase: Networks.TESTNET,
    settlementContract: kernel,
    authorizationSigner: createEd25519Signer(authorization.secret()),
    maxResourceFeeStroops: MAX_RESOURCE_FEE_STROOPS,
  };
}

function buyerTransaction(): Transaction {
  const xdrText = uptoPaymentXdr(kernel, authorization.publicKey(), {
    source: authorization.publicKey(),
    terms: { payer: buyer },
  });
  return new Transaction(xdrText, Networks.TESTNET);
}

describe('upto settlement resource fee ceiling', () => {
  it('builds a settlement whose resource fee is exactly at the ceiling', async () => {
    const built = await buildSettlementTransaction(
      contextWith(MAX_RESOURCE_FEE_STROOPS),
      buyerTransaction(),
      channel,
      requirements,
    );

    expect(built.source).toBe(channel);
  });

  it('refuses a settlement whose resource fee is one stroop above the ceiling', async () => {
    const building = buildSettlementTransaction(
      contextWith(MAX_RESOURCE_FEE_STROOPS + 1),
      buyerTransaction(),
      channel,
      requirements,
    );

    await expect(building).rejects.toBeInstanceOf(ResourceFeeExceededError);
    await expect(building).rejects.toThrow(
      `actual amount resource fee ${MAX_RESOURCE_FEE_STROOPS + 1} stroops exceeds ceiling ${MAX_RESOURCE_FEE_STROOPS} stroops`,
    );
  });
});
