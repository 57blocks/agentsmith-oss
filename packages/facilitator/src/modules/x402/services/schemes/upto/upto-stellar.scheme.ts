import type {
  Network,
  PaymentPayload,
  PaymentRequirements,
  SchemeNetworkFacilitator,
  SettleResponse,
  SupportedKind,
  VerifyResponse,
} from '@x402/core/types';
import {
  getNetworkPassphrase,
  getRpcClient,
  type FacilitatorStellarSigner,
  type RpcConfig,
} from '@x402/stellar';
import { ExactStellarScheme as ExactServerScheme } from '@x402/stellar/exact/server';
import { isZeroSettlement, zeroSettlement } from '../zero-settlement.js';
import { BASE_FEE, type Transaction } from '@stellar/stellar-sdk';
import type { Lease } from '../../../../channels/core/channel-pool.js';
import {
  TransactionPipeline,
  TransactionSigningError,
  type SubmissionOutcome,
} from '../../../../channels/core/transaction-pipeline.js';
import type { SettlementContexts } from '../../channels/settlement-context.js';
import {
  buildSettlementTransaction,
  CONFIRMATION_POLL_MS,
  CONFIRMATION_WAIT_MS,
  settleResponseFor,
  ResourceFeeExceededError,
  SigningError,
  type UptoSettlementContext,
} from './upto-settlement.js';
import { checkUptoPayment, type UptoVerifierContext } from './upto-verification.js';
import type { Logger } from '../../../../../common/logger.js';

export interface UptoStellarSchemeOptions {
  rpcConfig?: RpcConfig;
  areFeesSponsored?: boolean;
  /** Refuses a settlement whose simulated resource fee exceeds it. */
  maxResourceFeeStroops: number;
  contexts: SettlementContexts;
  authorizationSigner: FacilitatorStellarSigner;
  feeBumpSigner: FacilitatorStellarSigner;
  /** Receives why a settlement could not be built; the response carries only the reason code. */
  log?: Logger;
}

/** A settlement that stopped before broadcasting, or what its broadcast can still do. */
type Attempt = { response: SettleResponse } | { outcome: SubmissionOutcome };

/** Facilitator implementation for the Stellar Kernel-backed `upto` scheme. */
export class UptoStellarScheme implements SchemeNetworkFacilitator {
  readonly scheme = 'upto';
  readonly caipFamily = 'stellar:*';
  readonly areFeesSponsored: boolean;
  private readonly rpcConfig?: RpcConfig;
  private readonly maxResourceFeeStroops: number;
  private readonly settlementContract: string;
  private readonly contexts: SettlementContexts;
  private readonly authorizationSigner: FacilitatorStellarSigner;
  private readonly feeBumpSigner: FacilitatorStellarSigner;
  private readonly log?: Logger;
  private readonly serverPricing = new ExactServerScheme();

  constructor(settlementContract: string, options: UptoStellarSchemeOptions) {
    if (!settlementContract) throw new Error('upto settlement contract is required');
    this.settlementContract = settlementContract;
    this.rpcConfig = options.rpcConfig;
    this.areFeesSponsored = options.areFeesSponsored ?? true;
    this.maxResourceFeeStroops = options.maxResourceFeeStroops;
    this.contexts = options.contexts;
    this.authorizationSigner = options.authorizationSigner;
    if (!this.authorizationSigner) throw new Error('upto authorization signer is required');
    this.feeBumpSigner = options.feeBumpSigner;
    this.log = options.log;
  }

  getExtra(_: Network): Record<string, unknown> {
    return {
      areFeesSponsored: this.areFeesSponsored,
      settlementContract: this.settlementContract,
      facilitator: this.authorizationSigner.address,
    };
  }

  /** Only the authorization key: channels and the fee payer are not advertised. */
  getSigners(_: string): string[] {
    return [this.authorizationSigner.address];
  }

  async verify(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<VerifyResponse> {
    const checked = await checkUptoPayment(this.verifierContext(), payload, requirements, 'verify');
    return checked.response;
  }

  async settle(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<SettleResponse> {
    const checked = await checkUptoPayment(this.verifierContext(), payload, requirements, 'settle');
    const { network } = requirements;
    const { payer, transaction: signed } = checked;
    if (!checked.response.isValid || !checked.simulation || !signed || !payer) {
      const errorReason = checked.response.invalidReason || 'verification_failed';
      return { success: false, network, transaction: '', errorReason, payer };
    }
    if (isZeroSettlement(requirements)) return zeroSettlement(network, payer);

    // Leased only now, after verification, so a payment that fails it never holds a channel.
    const context = this.contexts.get();
    const lease = await context.acquire();
    context.selectedForSigning = true;
    const attempt = await this.attemptOn(lease, signed, requirements, payer);
    if ('response' in attempt) {
      context.outcome = { kind: 'not-sent' };
      return attempt.response;
    }
    context.outcome = attempt.outcome;
    return settleResponseFor(attempt.outcome, { network, payer, amount: requirements.amount });
  }

  /** Builds, signs and submits the settlement on one leased channel. */
  private async attemptOn(
    lease: Lease,
    signed: Transaction,
    requirements: PaymentRequirements,
    payer: string,
  ): Promise<Attempt> {
    const { network } = requirements;
    const context = this.settlementContext(requirements);
    const pipeline = new TransactionPipeline({
      rpc: context.rpc,
      networkPassphrase: context.networkPassphrase,
      confirmWaitMs: CONFIRMATION_WAIT_MS,
      pollMs: CONFIRMATION_POLL_MS,
    });
    let envelope;
    try {
      const unsigned = await buildSettlementTransaction(
        context,
        signed,
        lease.address,
        requirements,
      );
      envelope = await pipeline.sponsor(unsigned, lease.signer, this.feeBumpSigner, BASE_FEE);
    } catch (error) {
      // Nothing has been broadcast yet: building and signing happen before any send, so the
      // channel can be released at once.
      if (error instanceof SigningError || error instanceof TransactionSigningError) {
        const errorReason = 'settle_upto_signing_failed';
        return { response: { success: false, network, transaction: '', errorReason, payer } };
      }
      this.log?.warn('upto_settlement_build_failed', {
        channel: lease.address,
        errorName: error instanceof Error ? error.name : 'unknown',
        errorMessage: error instanceof Error ? error.message : 'unknown',
      });
      // The same reason verification gives, so a Resource Server can tell a fee overrun apart.
      const errorReason =
        error instanceof ResourceFeeExceededError
          ? 'invalid_upto_stellar_payload_fee_exceeds_maximum'
          : 'settle_upto_transaction_build_failed';
      return { response: { success: false, network, transaction: '', errorReason, payer } };
    }
    return { outcome: await pipeline.submit(envelope) };
  }

  private verifierContext(): UptoVerifierContext {
    return {
      settlementContract: this.settlementContract,
      authorizationAddress: this.authorizationSigner.address,
      rpcConfig: this.rpcConfig,
      maxResourceFeeStroops: this.maxResourceFeeStroops,
    };
  }

  private settlementContext(requirements: PaymentRequirements): UptoSettlementContext {
    return {
      rpc: getRpcClient(requirements.network, this.rpcConfig),
      networkPassphrase: getNetworkPassphrase(requirements.network),
      settlementContract: this.settlementContract,
      authorizationSigner: this.authorizationSigner,
      maxResourceFeeStroops: this.maxResourceFeeStroops,
    };
  }

  get defaultAssetTransferMethod(): string {
    return 'default';
  }
  // An x402 core payment flow, not the KMS key role: verify before the handler, settle after it.
  get paymentFlows(): Readonly<
    Record<string, { supported: readonly ['authorization']; default: 'authorization' }>
  > {
    return { default: { supported: ['authorization'], default: 'authorization' } };
  }
  parsePrice = this.serverPricing.parsePrice.bind(this.serverPricing);
  getAssetDecimals = this.serverPricing.getAssetDecimals.bind(this.serverPricing);
  enhancePaymentRequirements = async (
    requirements: PaymentRequirements,
    supported: SupportedKind,
    extensions: string[],
  ) => this.serverPricing.enhancePaymentRequirements(requirements, supported, extensions);
}
