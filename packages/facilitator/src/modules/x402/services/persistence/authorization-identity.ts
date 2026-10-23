import { createHash } from 'node:crypto';
import { Transaction, scValToNative } from '@stellar/stellar-sdk';
import type { PaymentPayload, PaymentRequirements } from '@x402/core/types';
import { getNetworkPassphrase } from '@x402/stellar';
import {
  addressOf,
  contractInvocation,
  readKernelArgs,
  type ContractInvocation,
} from '../schemes/upto/kernel-call.js';

/** Who pays, and the digest that identifies this Buyer authorization across retries. */
export interface AuthorizationIdentity {
  payer: string;
  signatureDigest: Buffer;
}

/** `exact` pays `transfer(from, …)`; `upto` pays from the Kernel terms' `payer`. */
function payerOf(invocation: ContractInvocation, scheme: string): string | undefined {
  if (scheme === 'upto') return readKernelArgs(invocation.args)?.terms.payer;
  const from = invocation.args[0];
  if (!from) return undefined;
  const value: unknown = scValToNative(from);
  return typeof value === 'string' ? value : undefined;
}

/**
 * The SHA-256 of the payer's whole authorization entry: address, nonce, expiration, signature and
 * invocation. A resent payload yields the same digest; two authorizations differ by their nonce
 * even when a contract account's signature does not vary. Undefined for a payload it cannot read.
 */
export function authorizationIdentity(
  payload: PaymentPayload,
  requirements: PaymentRequirements,
): AuthorizationIdentity | undefined {
  const xdr = (payload.payload as { transaction?: unknown }).transaction;
  if (typeof xdr !== 'string') return undefined;
  try {
    const transaction = new Transaction(xdr, getNetworkPassphrase(requirements.network));
    const invocation = contractInvocation(transaction);
    if (!invocation) return undefined;
    const payer = payerOf(invocation, requirements.scheme);
    if (!payer) return undefined;
    const entry = (invocation.op.auth ?? []).find((candidate) => addressOf(candidate) === payer);
    if (!entry) return undefined;
    return { payer, signatureDigest: createHash('sha256').update(entry.toXDR()).digest() };
  } catch {
    return undefined;
  }
}
