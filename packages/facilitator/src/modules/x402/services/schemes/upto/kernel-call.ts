import type { Operation, Transaction, xdr } from '@stellar/stellar-sdk';
import { Address, scValToNative } from '@stellar/stellar-sdk';
import type { PaymentRequirements } from '@x402/core/types';

export const KERNEL_METHOD = 'settle';

export type KernelTerms = {
  payer: string;
  asset: string;
  pay_to: string;
  facilitator: string;
  max_amount: bigint;
  valid_after_ledger: number;
  deadline_ledger: number;
};

export interface KernelArgs {
  terms: KernelTerms;
  actual: bigint;
}

export interface ContractInvocation {
  op: Operation.InvokeHostFunction;
  contract: string;
  method: string;
  args: xdr.ScVal[];
}

export function addressOf(entry: xdr.SorobanAuthorizationEntry): string | undefined {
  const credentials = entry.credentials();
  if (credentials.switch().name !== 'sorobanCredentialsAddress') return undefined;
  return Address.fromScAddress(credentials.address().address()).toString();
}

/** The transaction's single contract invocation, or undefined for any other first operation. */
export function contractInvocation(transaction: Transaction): ContractInvocation | undefined {
  const operation = transaction.operations[0];
  if (!operation || operation.type !== 'invokeHostFunction') return undefined;
  const op = operation as Operation.InvokeHostFunction;
  if (op.func.switch().name !== 'hostFunctionTypeInvokeContract') return undefined;
  const call = op.func.invokeContract();
  return {
    op,
    contract: Address.fromScAddress(call.contractAddress()).toString(),
    method: call.functionName().toString(),
    args: call.args(),
  };
}

function isKernelTerms(value: unknown): value is KernelTerms {
  if (!value || typeof value !== 'object') return false;
  const terms = value as Record<string, unknown>;
  return (
    typeof terms.payer === 'string' &&
    typeof terms.asset === 'string' &&
    typeof terms.pay_to === 'string' &&
    typeof terms.facilitator === 'string' &&
    Number.isSafeInteger(terms.valid_after_ledger) &&
    Number.isSafeInteger(terms.deadline_ledger)
  );
}

export function readKernelArgs(args: xdr.ScVal[]): KernelArgs | undefined {
  if (args.length !== 2) return undefined;
  const [termsVal, actualVal] = args;
  if (!termsVal || !actualVal) return undefined;
  const terms: unknown = scValToNative(termsVal);
  const actual = BigInt(scValToNative(actualVal) as bigint | number | string);
  if (!isKernelTerms(terms)) return undefined;
  return { terms, actual };
}

/** Whether the server's settlement terms are the ones the Buyer accepted, apart from the amount. */
export function samePayment(
  accepted: PaymentRequirements,
  requirements: PaymentRequirements,
): boolean {
  const acceptedExtra = accepted.extra || {};
  const requirementsExtra = requirements.extra || {};
  return (
    accepted.scheme === 'upto' &&
    requirements.scheme === 'upto' &&
    accepted.network === requirements.network &&
    accepted.asset === requirements.asset &&
    accepted.payTo === requirements.payTo &&
    accepted.maxTimeoutSeconds === requirements.maxTimeoutSeconds &&
    acceptedExtra.settlementContract === requirementsExtra.settlementContract &&
    acceptedExtra.facilitator === requirementsExtra.facilitator
  );
}
