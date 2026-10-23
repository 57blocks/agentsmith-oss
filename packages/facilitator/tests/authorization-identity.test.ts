import { Keypair, xdr } from '@stellar/stellar-sdk';
import type { PaymentPayload, PaymentRequirements } from '@x402/core/types';
import { describe, expect, it } from 'vitest';
import { authorizationIdentity } from '../src/modules/x402/services/persistence/authorization-identity.js';
import { asset, exactPaymentXdr, payTo } from './settlement-fixtures.js';

const requirements = {
  scheme: 'exact',
  network: 'stellar:testnet',
  asset,
  payTo,
  amount: '10000',
  maxTimeoutSeconds: 60,
  extra: {},
} as PaymentRequirements;

function identityOf(transaction: unknown) {
  const payload = { x402Version: 2, accepted: requirements, payload: { transaction } };
  return authorizationIdentity(payload as PaymentPayload, requirements);
}

describe('authorization identity', () => {
  it('names the payer and gives a resent payload the same digest', () => {
    const buyer = Keypair.random().publicKey();
    const payment = exactPaymentXdr({ buyer });

    const first = identityOf(payment);
    expect(first?.payer).toBe(buyer);
    expect(first?.signatureDigest).toHaveLength(32);
    expect(identityOf(payment)?.signatureDigest).toEqual(first?.signatureDigest);
  });

  it('separates two authorizations whose contract-account signatures are identical', () => {
    const buyer = Keypair.random().publicKey();
    const signature = xdr.ScVal.scvVoid();
    const first = identityOf(exactPaymentXdr({ buyer, nonce: 1n, signature }));
    const second = identityOf(exactPaymentXdr({ buyer, nonce: 2n, signature }));

    expect(first?.signatureDigest).not.toEqual(second?.signatureDigest);
  });

  it('cannot identify a payload that is not a readable Buyer transaction', () => {
    expect(identityOf(undefined)).toBeUndefined();
    expect(identityOf('not-xdr')).toBeUndefined();
  });
});
