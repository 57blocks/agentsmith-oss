import {
  Address,
  Keypair,
  Transaction,
  buildAuthorizationEntryPreimage,
  contract,
  hash,
  scValToNative,
} from '@stellar/stellar-sdk';
import { getNetworkPassphrase, getRpcUrl } from '@x402/stellar';
import type { Network, PaymentPayload, PaymentRequirements } from '@x402/core/types';
import { expect } from 'vitest';

export async function readTokenBalance(
  asset: string,
  payer: string,
  network: Network,
): Promise<bigint> {
  const query = await contract.AssembledTransaction.build({
    contractId: asset,
    method: 'balance',
    args: [Address.fromString(payer).toScVal()],
    publicKey: payer,
    networkPassphrase: getNetworkPassphrase(network),
    rpcUrl: getRpcUrl(network),
    parseResultXdr: (value) => {
      const balance: unknown = scValToNative(value);
      if (typeof balance !== 'bigint') throw new Error('Token balance did not return an i128');
      return balance;
    },
  });
  return query.result;
}

export function expectSignedPayment(
  payment: PaymentPayload,
  requirements: PaymentRequirements,
  payer: string,
): void {
  const encoded = payment.payload.transaction;
  if (typeof encoded !== 'string') throw new Error('Missing signed transaction XDR');
  const signed = new Transaction(encoded, getNetworkPassphrase(requirements.network));
  expect(signed.operations).toHaveLength(1);
  const operation = signed.operations[0];
  if (
    !operation ||
    operation.type !== 'invokeHostFunction' ||
    operation.func.switch().name !== 'hostFunctionTypeInvokeContract'
  ) {
    throw new Error('Payment must contain a single contract invocation');
  }
  const invocation = operation.func.invokeContract();
  const target = Address.fromScAddress(invocation.contractAddress()).toString();
  const args = invocation.args().map((value) => scValToNative(value));
  if (requirements.scheme === 'exact') {
    expect(target).toBe(requirements.asset);
    expect(invocation.functionName().toString()).toBe('transfer');
    expect(args).toEqual([payer, requirements.payTo, BigInt(requirements.amount)]);
  } else {
    expect(target).toBe(requirements.extra.settlementContract);
    expect(invocation.functionName().toString()).toBe('settle');
    expect(signed.source).toBe(requirements.extra.facilitator);
    expect(args).toHaveLength(2);
    expect(args[0]).toMatchObject({
      payer,
      asset: requirements.asset,
      pay_to: requirements.payTo,
      facilitator: requirements.extra.facilitator,
      max_amount: BigInt(requirements.amount),
    });
    expect(args[1]).toBe(BigInt(requirements.amount));
  }
  const buyerAuth = (operation.auth ?? []).filter((entry) => {
    const credentials = entry.credentials();
    return (
      credentials.switch().name === 'sorobanCredentialsAddress' &&
      Address.fromScAddress(credentials.address().address()).toString() === payer
    );
  });
  expect(buyerAuth).toHaveLength(1);
  const entry = buyerAuth[0];
  if (!entry) throw new Error('Missing Buyer authorization');
  expect(entry.credentials().address().signature().switch().name).toBe('scvVec');
  const preimage = buildAuthorizationEntryPreimage(
    entry,
    entry.credentials().address().signatureExpirationLedger(),
    getNetworkPassphrase(requirements.network),
  );
  const signatures: unknown = scValToNative(entry.credentials().address().signature());
  if (!Array.isArray(signatures) || signatures.length !== 1)
    throw new Error('Expected one signature');
  const signature: unknown = signatures[0];
  if (
    typeof signature !== 'object' ||
    signature === null ||
    !('public_key' in signature) ||
    !('signature' in signature) ||
    !Buffer.isBuffer(signature.public_key) ||
    !Buffer.isBuffer(signature.signature)
  )
    throw new Error('Invalid Buyer signature');
  const publicKey = Keypair.fromPublicKey(payer);
  expect(signature.public_key).toEqual(publicKey.rawPublicKey());
  expect(publicKey.verify(hash(preimage.toXDR()), signature.signature)).toBe(true);
}
