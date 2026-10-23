import type { Transaction } from '@stellar/stellar-sdk';
import {
  Account,
  Address,
  BASE_FEE,
  Operation,
  TransactionBuilder,
  authorizeEntry,
  nativeToScVal,
  xdr,
} from '@stellar/stellar-sdk';
import { Api, assembleTransaction } from '@stellar/stellar-sdk/rpc';
import type { PaymentRequirements, SettleResponse } from '@x402/core/types';
import type { getRpcClient } from '@x402/stellar';
import { type FacilitatorStellarSigner } from '@x402/stellar';
import type { SubmissionOutcome } from '../../../../channels/core/transaction-pipeline.js';
import { addressOf, contractInvocation, readKernelArgs, type KernelTerms } from './kernel-call.js';
import { DEFAULT_TIMEOUT_SECONDS } from './upto-verification.js';

/** How long a settle waits for the transaction's status before reporting it pending. */
export const CONFIRMATION_WAIT_MS = 20_000;
export const CONFIRMATION_POLL_MS = 1_000;

type RpcClient = ReturnType<typeof getRpcClient>;

export interface UptoSettlementContext {
  rpc: RpcClient;
  networkPassphrase: string;
  settlementContract: string;
  authorizationSigner: FacilitatorStellarSigner;
  maxResourceFeeStroops: number;
}

/** A signer refused or failed to sign; nothing has been broadcast. */
export class SigningError extends Error {
  override name = 'SigningError';
}

/** The actual-amount settlement's simulated resource fee is above the ceiling; nothing was sent. */
export class ResourceFeeExceededError extends Error {
  override name = 'ResourceFeeExceededError';
}

/** The Buyer's signed call, rewritten to charge the actual amount. */
interface ActualAmountCall {
  func: xdr.HostFunction;
  terms: KernelTerms;
  buyerAuth: xdr.SorobanAuthorizationEntry;
}

interface EnvelopeOptions {
  account: Account;
  operation: xdr.Operation;
  template: Transaction;
  requirements: PaymentRequirements;
  context: UptoSettlementContext;
}

function actualAmountCall(
  signed: Transaction,
  settlementContract: string,
  actualAmount: string,
): ActualAmountCall {
  const invocation = contractInvocation(signed);
  if (!invocation) throw new Error('invalid invoke operation');
  const kernel = readKernelArgs(invocation.args);
  if (!kernel) throw new Error('invalid kernel arguments');
  const callArgs = [...invocation.args];
  callArgs[1] = nativeToScVal(BigInt(actualAmount), { type: 'i128' });
  const func = xdr.HostFunction.hostFunctionTypeInvokeContract(
    new xdr.InvokeContractArgs({
      contractAddress: Address.fromString(settlementContract).toScAddress(),
      functionName: invocation.method,
      args: callArgs,
    }),
  );
  const buyerAuth = (invocation.op.auth || [])
    .map((entry) => xdr.SorobanAuthorizationEntry.fromXDR(entry.toXDR()))
    .find((entry) => addressOf(entry) === kernel.terms.payer);
  if (!buyerAuth) throw new Error('buyer authorization is missing');
  return { func, terms: kernel.terms, buyerAuth };
}

/** Never deliberately select an older observed sequence than `floor`. */
async function latestSequence(rpc: RpcClient, address: string, floor?: string): Promise<string> {
  const account = await rpc.getAccount(address);
  const observed = account.sequenceNumber();
  return floor !== undefined && BigInt(floor) >= BigInt(observed) ? floor : observed;
}

function buildEnvelope(options: EnvelopeOptions): Transaction {
  const { account, operation, template, requirements, context } = options;
  return new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: context.networkPassphrase,
    memo: template.memo,
  })
    .setTimeout(requirements.maxTimeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS)
    .addOperation(operation)
    .build();
}

async function simulateOrThrow(
  rpc: RpcClient,
  transaction: Transaction,
): Promise<Api.SimulateTransactionSuccessResponse> {
  const simulation = await rpc.simulateTransaction(transaction);
  if (!Api.isSimulationSuccess(simulation))
    throw new Error(
      `actual amount simulation failed${'error' in simulation && simulation.error ? `: ${simulation.error}` : ''}`,
    );
  return simulation;
}

/**
 * Adapts the x402 signer to Stellar's authorization callback without exposing its secret. Signers
 * must report failure as `{ error }`; a thrown error is not mapped to `SigningError` and so is an
 * unknown outcome (the channel stays parked).
 */
export function signFacilitatorAuthEntry(
  entry: xdr.SorobanAuthorizationEntry,
  signer: FacilitatorStellarSigner,
  validUntilLedger: number,
  networkPassphrase: string,
): Promise<xdr.SorobanAuthorizationEntry> {
  return authorizeEntry(
    entry,
    async (preimage) => {
      const result = await signer.signAuthEntry(preimage.toXDR('base64'), {
        networkPassphrase,
        address: signer.address,
      });
      if (result.error) throw new SigningError(result.error.message);
      if (
        !result.signedAuthEntry ||
        (result.signerAddress && result.signerAddress !== signer.address)
      ) {
        throw new SigningError('facilitator authorization signer failed');
      }
      return {
        signature: Buffer.from(result.signedAuthEntry, 'base64'),
        publicKey: signer.address,
      };
    },
    validUntilLedger,
    networkPassphrase,
  );
}

/** Signs the facilitator's generated entry and keeps the Buyer's original one in its place. */
async function authorizeEntries(
  context: UptoSettlementContext,
  call: ActualAmountCall,
  sourceAddress: string,
  generated: readonly xdr.SorobanAuthorizationEntry[],
): Promise<xdr.SorobanAuthorizationEntry[]> {
  const authorizationAddress = context.authorizationSigner.address;
  if (
    sourceAddress !== authorizationAddress &&
    generated.filter((entry) => addressOf(entry) === authorizationAddress).length !== 1
  )
    throw new Error('facilitator authorization is missing or ambiguous');
  return Promise.all(
    generated.map(async (entry) => {
      const address = addressOf(entry);
      if (address === call.terms.payer) return call.buyerAuth;
      if (address !== authorizationAddress)
        throw new Error('unexpected authorization address in simulation');
      return signFacilitatorAuthEntry(
        entry,
        context.authorizationSigner,
        call.terms.deadline_ledger,
        context.networkPassphrase,
      );
    }),
  );
}

/**
 * First lets Soroban build the complete authorization tree, then re-simulates with the Buyer's
 * original entry so its nonce is part of the final footprint.
 */
async function assembleAuthorizedCall(
  context: UptoSettlementContext,
  call: ActualAmountCall,
  base: Omit<EnvelopeOptions, 'operation'>,
): Promise<Transaction> {
  const unauthorized = buildEnvelope({
    ...base,
    operation: Operation.invokeHostFunction({ func: call.func }),
  });
  const firstSimulation = await simulateOrThrow(context.rpc, unauthorized);
  const generated = assembleTransaction(unauthorized, firstSimulation).build();
  const generatedOp = generated.operations[0] as Operation.InvokeHostFunction;
  const auth = await authorizeEntries(
    context,
    call,
    base.account.accountId(),
    generatedOp.auth || [],
  );
  const authorized = buildEnvelope({
    ...base,
    operation: Operation.invokeHostFunction({ func: call.func, auth }),
  });
  const simulation = await simulateOrThrow(context.rpc, authorized);
  const resourceFee = parseInt(simulation.minResourceFee, 10);
  if (resourceFee > context.maxResourceFeeStroops)
    throw new ResourceFeeExceededError(
      `actual amount resource fee ${resourceFee} stroops exceeds ceiling ${context.maxResourceFeeStroops} stroops`,
    );
  const assembled = assembleTransaction(authorized, simulation).build();
  (assembled.operations[0] as Operation.InvokeHostFunction).auth = auth;
  return assembled;
}

/**
 * Rebuilds once from the latest source-account sequence. Some RPC nodes return a stale account
 * snapshot during simulation; the Soroban data and auth entries stay valid when only the envelope
 * sequence changes.
 */
async function rebuildAtLatestSequence(
  context: UptoSettlementContext,
  assembled: Transaction,
  source: { address: string; floorSequence: string },
  requirements: PaymentRequirements,
): Promise<Transaction> {
  const sequence = await latestSequence(context.rpc, source.address, source.floorSequence);
  const operation = assembled.operations[0] as Operation.InvokeHostFunction;
  return new TransactionBuilder(new Account(source.address, sequence), {
    // TransactionBuilder adds sorobanData.resourceFee to this inclusion fee.
    fee: BASE_FEE,
    networkPassphrase: context.networkPassphrase,
    memo: assembled.memo,
    sorobanData: assembled.toEnvelope().v1().tx().ext().value() || undefined,
  })
    .setTimeout(requirements.maxTimeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS)
    .addOperation(
      Operation.invokeHostFunction({
        source: operation.source,
        func: operation.func,
        auth: operation.auth,
      }),
    )
    .build();
}

/** Builds the final, unsigned settlement transaction charging `requirements.amount`. */
export async function buildSettlementTransaction(
  context: UptoSettlementContext,
  signed: Transaction,
  sourceAddress: string,
  requirements: PaymentRequirements,
): Promise<Transaction> {
  const call = actualAmountCall(signed, context.settlementContract, requirements.amount);
  const first = await latestSequence(context.rpc, sourceAddress);
  const sequence = await latestSequence(context.rpc, sourceAddress, first);
  const base = { account: new Account(sourceAddress, sequence), template: signed, requirements };
  const assembled = await assembleAuthorizedCall(context, call, { ...base, context });
  return rebuildAtLatestSequence(
    context,
    assembled,
    { address: sourceAddress, floorSequence: sequence },
    requirements,
  );
}

/**
 * The `upto` settle response for a submission outcome. A refused broadcast keeps today's
 * `unexpected_settle_error` without a hash: a hash would make the engine report and reconcile it
 * as a pending broadcast.
 */
export function settleResponseFor(
  outcome: SubmissionOutcome,
  receipt: Pick<SettleResponse, 'network' | 'payer'> & { amount: string },
): SettleResponse {
  const { network, payer, amount } = receipt;
  switch (outcome.kind) {
    case 'included':
      return outcome.successful
        ? { success: true, network, transaction: outcome.hash, payer, amount }
        : {
            success: false,
            network,
            transaction: outcome.hash,
            errorReason: 'settle_upto_transaction_failed',
            payer,
          };
    case 'unknown':
      return {
        success: false,
        network,
        transaction: outcome.hash ?? '',
        errorReason: 'settlement_pending',
        payer,
      };
    case 'rejected':
    case 'not-sent':
      return {
        success: false,
        network,
        transaction: '',
        errorReason: 'unexpected_settle_error',
        payer,
      };
  }
}
