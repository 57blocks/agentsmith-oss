import {
  Address,
  StrKey,
  contract,
  inspectAuthEntry,
  nativeToScVal,
  xdr,
} from '@stellar/stellar-sdk';
import { Api } from '@stellar/stellar-sdk/rpc';
import type {
  Network,
  PaymentPayload,
  PaymentRequirements,
  SchemeNetworkClient,
} from '@x402/core/types';
import {
  findDefaultAsset,
  getEstimatedLedgerCloseTimeSeconds,
  getNetworkPassphrase,
  getRpcClient,
  getRpcUrl,
  isStellarNetwork,
  validateStellarDestinationAddress,
} from '@x402/stellar';
import type { ClientStellarSigner, RpcConfig } from '@x402/stellar';
import { assertUptoMetadata } from './metadata.js';
import { trustedUptoKernel } from './kernel.js';
import { isPositiveI128 } from '../amount.js';

/** Buyer authorization for AgentSmith's experimental Kernel-backed Stellar upto scheme. */
export class UptoStellarClient implements SchemeNetworkClient {
  readonly scheme = 'upto';
  /**
   * Looks up upstream default-asset metadata for spend controls, or returns undefined.
   * An unrecognized token can still be used through explicit SEP-41 asset/amount requirements.
   */
  readonly findDefaultAsset = findDefaultAsset;

  /**
   * Uses a caller-owned signer and optional RPC settings. The trusted Kernel is not a caller input:
   * it is the SDK-pinned contract for the requirement's network ({@link trustedUptoKernel}).
   */
  constructor(
    private readonly signer: ClientStellarSigner,
    private readonly rpcConfig?: RpcConfig,
  ) {}

  /**
   * Creates a Kernel payment payload authorizing at most the quoted atomic amount in any SEP-41 token.
   * Uses the advertised facilitator authorization address as the transaction source, simulates the
   * call, checks the full authorization tree against the approved quote and signs only the Buyer's
   * auth entry. It does not sign the envelope or broadcast payment.
   * @returns The native x402 payload fields containing the serialized authorized transaction.
   * @throws TypeError for untrusted Kernel addresses, incompatible terms, metadata or ledger bounds.
   * @throws Error for RPC/simulation failures, unexpected authorization or wallet rejection.
   */
  async createPaymentPayload(
    x402Version: number,
    requirements: PaymentRequirements,
  ): Promise<Pick<PaymentPayload, 'x402Version' | 'payload'>> {
    validateRequirements(x402Version, requirements);
    assertUptoMetadata(requirements);
    const trusted = resolveTrustedKernel(requirements.network, requirements.extra);
    const { facilitator } = requirements.extra;
    const rpcUrl = getRpcUrl(requirements.network, this.rpcConfig);
    const window = await authorizationWindow(requirements, this.rpcConfig);
    const { expiration } = window;
    const args = kernelArguments(requirements, this.signer.address, facilitator, window);
    const expected = buyerAuthorization({
      requirements,
      payer: this.signer.address,
      terms: args[0]!,
      expiration,
      kernel: trusted,
    });
    const tx = await contract.AssembledTransaction.build({
      contractId: trusted,
      method: 'settle',
      args,
      publicKey: facilitator,
      networkPassphrase: getNetworkPassphrase(requirements.network),
      rpcUrl,
      timeoutInSeconds: window.timeout,
      parseResultXdr: (value) => value,
    });
    assertSimulationSucceeded(tx.simulation);
    const missing = tx.needsNonInvokerSigningBy();
    if (missing.length !== 1 || missing[0] !== this.signer.address) {
      throw new Error('upto simulation must request only the Buyer authorization');
    }
    assertBuyerAuthorization(tx, this.signer.address, expected);
    await tx.signAuthEntries({
      address: this.signer.address,
      signAuthEntry: this.signer.signAuthEntry,
      expiration,
    });
    await tx.simulate();
    assertSimulationSucceeded(tx.simulation);
    if (tx.needsNonInvokerSigningBy().length > 0 || !tx.built) {
      throw new Error('upto Buyer authorization is incomplete');
    }
    assertBuyerAuthorization(tx, this.signer.address, expected);
    return { x402Version, payload: { transaction: tx.built.toXDR() } };
  }
}

function assertSimulationSucceeded(simulation?: Api.SimulateTransactionResponse): void {
  if (simulation && Api.isSimulationError(simulation)) {
    throw new Error(`Stellar upto simulation failed: ${simulation.error}`);
  }
  if (!simulation || !Api.isSimulationSuccess(simulation) || Api.isSimulationRestore(simulation)) {
    throw new Error('Stellar upto simulation did not produce a usable transaction');
  }
}

function validateRequirements(version: number, requirements: PaymentRequirements): void {
  const timeout = requirements.maxTimeoutSeconds ?? 60;
  if (
    version !== 2 ||
    requirements.scheme !== 'upto' ||
    !isStellarNetwork(requirements.network) ||
    !StrKey.isValidContract(requirements.asset) ||
    !validateStellarDestinationAddress(requirements.payTo) ||
    !isPositiveI128(requirements.amount) ||
    !Number.isSafeInteger(timeout) ||
    timeout <= 0
  ) {
    throw new TypeError('Invalid Stellar upto payment requirements');
  }
}

async function authorizationWindow(requirements: PaymentRequirements, rpcConfig?: RpcConfig) {
  const rpc = getRpcClient(requirements.network, rpcConfig);
  const { sequence: current } = await rpc.getLatestLedger();
  const ledgerSeconds = await getEstimatedLedgerCloseTimeSeconds(requirements.network);
  const timeout = requirements.maxTimeoutSeconds ?? 60;
  const expiration = current + Math.ceil(timeout / ledgerSeconds);
  if (
    !Number.isSafeInteger(current) ||
    current < 0 ||
    current > 0xffffffff ||
    !Number.isSafeInteger(expiration) ||
    expiration <= current ||
    expiration > 0xffffffff
  ) {
    throw new TypeError('Invalid upto ledger validity window');
  }
  return { current, expiration, timeout };
}

function kernelArguments(
  requirements: PaymentRequirements,
  payer: string,
  facilitator: string,
  window: { current: number; expiration: number },
) {
  const maximum = nativeToScVal(requirements.amount, { type: 'i128' });
  const terms = nativeToScVal(
    new Map([
      ['payer', nativeToScVal(payer, { type: 'address' })],
      ['asset', nativeToScVal(requirements.asset, { type: 'address' })],
      ['pay_to', nativeToScVal(requirements.payTo, { type: 'address' })],
      ['facilitator', nativeToScVal(facilitator, { type: 'address' })],
      ['max_amount', maximum],
      ['valid_after_ledger', nativeToScVal(window.current, { type: 'u32' })],
      ['deadline_ledger', nativeToScVal(window.expiration, { type: 'u32' })],
    ]),
    { type: ['symbol', null] },
  );
  // The Buyer signs at the maximum; only the Facilitator substitutes actual usage at settlement.
  return [terms, maximum];
}

/**
 * Resolves the SDK-pinned Kernel for the requirement's network and refuses any Facilitator
 * advertising a different one. The advertised address is compared, never adopted.
 */
function resolveTrustedKernel(
  network: Network,
  extra: { settlementContract: string; areFeesSponsored: boolean },
): string {
  if (!extra.areFeesSponsored) {
    throw new TypeError('upto requires sponsored fees');
  }
  const trusted = trustedUptoKernel(network);
  if (!trusted) {
    throw new TypeError('upto is not available on this network');
  }
  if (extra.settlementContract !== trusted) {
    throw new TypeError('upto requires the SDK-trusted Kernel contract address');
  }
  return trusted;
}

interface BuyerAuthorizationInput {
  requirements: PaymentRequirements;
  payer: string;
  terms: xdr.ScVal;
  expiration: number;
  kernel: string;
}

function buyerAuthorization({
  requirements,
  payer,
  terms,
  expiration,
  kernel,
}: BuyerAuthorizationInput) {
  const approval = authorizedCall(requirements.asset, 'approve', [
    nativeToScVal(payer, { type: 'address' }),
    nativeToScVal(kernel, { type: 'address' }),
    nativeToScVal(requirements.amount, { type: 'i128' }),
    nativeToScVal(expiration, { type: 'u32' }),
  ]);
  // Kernel require_auth_for_args deliberately excludes actual_amount from Buyer authorization.
  return authorizedCall(kernel, 'settle', [terms], [approval]);
}

function authorizedCall(
  contractId: string,
  method: string,
  args: xdr.ScVal[],
  children: xdr.SorobanAuthorizedInvocation[] = [],
) {
  return new xdr.SorobanAuthorizedInvocation({
    function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
      new xdr.InvokeContractArgs({
        contractAddress: Address.fromString(contractId).toScAddress(),
        functionName: method,
        args,
      }),
    ),
    subInvocations: children,
  });
}

function assertBuyerAuthorization(
  tx: contract.AssembledTransaction<xdr.ScVal>,
  payer: string,
  expected: xdr.SorobanAuthorizedInvocation,
) {
  const operation = tx.built?.operations[0];
  if (tx.built?.operations.length !== 1 || operation?.type !== 'invokeHostFunction') {
    throw new Error('Unexpected upto authorization transaction');
  }
  const entries = (operation.auth ?? []).filter(
    (entry) => inspectAuthEntry(entry).address === payer,
  );
  if (
    entries.length !== 1 ||
    entries[0]!.rootInvocation().toXDR('base64') !== expected.toXDR('base64')
  ) {
    throw new Error('upto Buyer authorization does not match the approved payment terms');
  }
}
