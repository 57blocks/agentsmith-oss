import type { xdr } from '@stellar/stellar-sdk';
import { Transaction } from '@stellar/stellar-sdk';
import { Api } from '@stellar/stellar-sdk/rpc';
import type { PaymentPayload, PaymentRequirements, VerifyResponse } from '@x402/core/types';
import {
  getEstimatedLedgerCloseTimeSeconds,
  getNetworkPassphrase,
  getRpcClient,
  isStellarNetwork,
  type RpcConfig,
} from '@x402/stellar';
import {
  KERNEL_METHOD,
  addressOf,
  contractInvocation,
  readKernelArgs,
  samePayment,
  type ContractInvocation,
  type KernelArgs,
  type KernelTerms,
} from './kernel-call.js';
import { hasSourcePreconditions } from '../source-preconditions.js';

export const DEFAULT_TIMEOUT_SECONDS = 60;
const MAX_LEDGER_TOLERANCE = 2;

export type CheckPhase = 'verify' | 'settle';

export interface UptoVerifierContext {
  settlementContract: string;
  authorizationAddress: string;
  rpcConfig?: RpcConfig;
  maxResourceFeeStroops: number;
}

export interface UptoCheck {
  response: VerifyResponse;
  transaction?: Transaction;
  simulation?: Api.SimulateTransactionResponse;
  payer?: string;
}

interface UptoRequest {
  payload: PaymentPayload;
  requirements: PaymentRequirements;
  phase: CheckPhase;
}

interface Rejected {
  rejected: VerifyResponse;
}

interface KernelTransaction {
  transaction: Transaction;
  invocation: ContractInvocation;
  kernel: KernelArgs;
}

/** The current ledger and the latest ledger an authorization may still expire at. */
interface LedgerWindow {
  current: number;
  latestExpiration: number;
}

type RpcClient = ReturnType<typeof getRpcClient>;

function invalid(reason: string, payer?: string, message?: string): VerifyResponse {
  return { isValid: false, invalidReason: reason, payer, invalidMessage: message };
}

function reject(reason: string, payer?: string, message?: string): Rejected {
  return { rejected: invalid(reason, payer, message) };
}

function checkRequestTerms(
  payload: PaymentPayload,
  requirements: PaymentRequirements,
): Rejected | undefined {
  const accepted = payload.accepted;
  if (payload.x402Version !== 2 || accepted.scheme !== 'upto' || requirements.scheme !== 'upto')
    return reject('unsupported_scheme');
  if (!samePayment(accepted, requirements) || !isStellarNetwork(requirements.network))
    return reject('invalid_upto_stellar_payload_terms');
  if (!/^[1-9][0-9]*$/.test(accepted.amount) || !/^[0-9]+$/.test(requirements.amount))
    return reject('invalid_upto_stellar_payload_amount');
  return undefined;
}

/** The Buyer's transaction, or undefined when the text is not a transaction envelope. */
function decodeTransaction(
  transactionXdr: string,
  requirements: PaymentRequirements,
): Transaction | undefined {
  const passphrase = getNetworkPassphrase(requirements.network);
  try {
    return new Transaction(transactionXdr, passphrase);
  } catch {
    return undefined;
  }
}

function parseKernelTransaction(
  context: UptoVerifierContext,
  payload: PaymentPayload,
  requirements: PaymentRequirements,
): Rejected | KernelTransaction {
  const transactionXdr = (payload.payload as { transaction?: unknown })?.transaction;
  if (typeof transactionXdr !== 'string') return reject('invalid_upto_stellar_payload_malformed');
  const transaction = decodeTransaction(transactionXdr, requirements);
  if (!transaction) return reject('invalid_upto_stellar_payload_malformed');
  if (hasSourcePreconditions(transaction))
    return reject('invalid_upto_stellar_payload_preconditions');
  const invocation = contractInvocation(transaction);
  if (
    !invocation ||
    invocation.contract !== context.settlementContract ||
    invocation.method !== KERNEL_METHOD
  )
    return reject('invalid_upto_stellar_payload_wrong_kernel');
  if (
    transaction.source !== context.authorizationAddress ||
    (invocation.op.source && invocation.op.source !== transaction.source)
  )
    return reject('invalid_upto_stellar_payload_unsafe_source');
  const kernel = readKernelArgs(invocation.args);
  if (!kernel) return reject('invalid_upto_stellar_payload_arguments');
  return { transaction, invocation, kernel };
}

function checkKernelTerms(
  context: UptoVerifierContext,
  kernel: KernelArgs,
  request: UptoRequest,
): Rejected | undefined {
  const { terms } = kernel;
  const { payload, requirements, phase } = request;
  const acceptedExtra = payload.accepted.extra || {};
  const maximum = BigInt(payload.accepted.amount);
  if (
    acceptedExtra.settlementContract !== context.settlementContract ||
    acceptedExtra.facilitator !== terms.facilitator ||
    terms.asset !== payload.accepted.asset ||
    terms.pay_to !== payload.accepted.payTo ||
    terms.max_amount !== maximum ||
    terms.facilitator !== context.authorizationAddress
  )
    return reject('invalid_upto_stellar_payload_terms', terms.payer);
  const requestedAmount = BigInt(requirements.amount);
  if (requestedAmount > maximum || (phase === 'verify' && requestedAmount !== maximum))
    return reject('invalid_upto_stellar_payload_amount', terms.payer);
  // The Buyer signs the call at its maximum; the actual amount is substituted only at settlement.
  if (kernel.actual !== maximum)
    return reject('invalid_upto_stellar_payload_max_amount', terms.payer);
  return undefined;
}

async function ledgerWindow(
  rpc: RpcClient,
  payload: PaymentPayload,
  requirements: PaymentRequirements,
): Promise<LedgerWindow> {
  const latest = await rpc.getLatestLedger();
  const timeoutSeconds = payload.accepted.maxTimeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS;
  const closeSeconds = await getEstimatedLedgerCloseTimeSeconds(requirements.network);
  const maxLedger = latest.sequence + Math.ceil(timeoutSeconds / closeSeconds);
  return { current: latest.sequence, latestExpiration: maxLedger + MAX_LEDGER_TOLERANCE };
}

function isWithinKernelWindow(terms: KernelTerms, window: LedgerWindow): boolean {
  return (
    terms.valid_after_ledger <= terms.deadline_ledger &&
    window.current >= terms.valid_after_ledger &&
    terms.deadline_ledger >= window.current &&
    terms.deadline_ledger <= window.latestExpiration
  );
}

async function simulateWithinFeeLimit(
  context: UptoVerifierContext,
  rpc: RpcClient,
  transaction: Transaction,
  payer: string,
): Promise<Rejected | { simulation: Api.SimulateTransactionResponse }> {
  const simulation = await rpc.simulateTransaction(transaction);
  if (!Api.isSimulationSuccess(simulation))
    return reject('invalid_upto_stellar_payload_simulation_failed', payer);
  if (parseInt(simulation.minResourceFee, 10) > context.maxResourceFeeStroops)
    return reject('invalid_upto_stellar_payload_fee_exceeds_maximum', payer);
  return { simulation };
}

/** Checks one authorization entry; returns whether it is the Buyer's, or why it is rejected. */
function checkAuthEntry(
  entry: xdr.SorobanAuthorizationEntry,
  context: UptoVerifierContext,
  terms: KernelTerms,
  window: LedgerWindow,
): Rejected | { isBuyer: boolean } {
  const { payer } = terms;
  const address = addressOf(entry);
  if (address && address !== payer && address !== context.authorizationAddress)
    return reject('invalid_upto_stellar_payload_auth', payer);
  const credentials = entry.credentials();
  if (credentials.switch().name !== 'sorobanCredentialsAddress') return { isBuyer: false };
  const expiration = credentials.address().signatureExpirationLedger();
  if (expiration < window.current) return reject('invalid_upto_stellar_payload_expired', payer);
  const isBuyer = address === payer;
  if (
    expiration > window.latestExpiration ||
    (isBuyer && expiration !== terms.deadline_ledger) ||
    (!isBuyer && expiration > terms.deadline_ledger)
  )
    return reject('invalid_upto_stellar_payload_expiration', payer);
  return { isBuyer };
}

function checkAuthEntries(
  invocation: ContractInvocation,
  context: UptoVerifierContext,
  terms: KernelTerms,
  window: LedgerWindow,
): Rejected | undefined {
  let buyerAuthorizations = 0;
  for (const entry of invocation.op.auth || []) {
    const checked = checkAuthEntry(entry, context, terms, window);
    if ('rejected' in checked) return checked;
    if (checked.isBuyer) buyerAuthorizations += 1;
  }
  if (buyerAuthorizations !== 1) return reject('invalid_upto_stellar_payload_auth', terms.payer);
  return undefined;
}

async function checkOnChain(
  context: UptoVerifierContext,
  parsed: KernelTransaction,
  payload: PaymentPayload,
  requirements: PaymentRequirements,
): Promise<UptoCheck> {
  const { terms } = parsed.kernel;
  const rpc = getRpcClient(requirements.network, context.rpcConfig);
  const window = await ledgerWindow(rpc, payload, requirements);
  if (!isWithinKernelWindow(terms, window))
    return { response: invalid('invalid_upto_stellar_payload_expiration', terms.payer) };
  const simulated = await simulateWithinFeeLimit(context, rpc, parsed.transaction, terms.payer);
  if ('rejected' in simulated) return { response: simulated.rejected };
  const authRejected = checkAuthEntries(parsed.invocation, context, terms, window);
  if (authRejected) return { response: authRejected.rejected };
  return {
    response: { isValid: true, payer: terms.payer },
    transaction: parsed.transaction,
    simulation: simulated.simulation,
    payer: terms.payer,
  };
}

/**
 * Validates an `upto` authorization against the requested terms, the ledger window and a
 * simulation. Never throws: unexpected failures become `unexpected_verify_error`.
 */
export async function checkUptoPayment(
  context: UptoVerifierContext,
  payload: PaymentPayload,
  requirements: PaymentRequirements,
  phase: CheckPhase,
): Promise<UptoCheck> {
  let payer: string | undefined;
  try {
    const requestRejected = checkRequestTerms(payload, requirements);
    if (requestRejected) return { response: requestRejected.rejected };
    const parsed = parseKernelTransaction(context, payload, requirements);
    if ('rejected' in parsed) return { response: parsed.rejected };
    payer = parsed.kernel.terms.payer;
    const termsRejected = checkKernelTerms(context, parsed.kernel, {
      payload,
      requirements,
      phase,
    });
    if (termsRejected) return { response: termsRejected.rejected };
    return await checkOnChain(context, parsed, payload, requirements);
  } catch {
    return { response: invalid('unexpected_verify_error', payer) };
  }
}
