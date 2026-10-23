import type {
  Network,
  PaymentPayload,
  PaymentRequirements,
  SchemeNetworkFacilitator,
  SettleResponse,
  VerifyResponse,
} from '@x402/core/types';
import { Transaction } from '@stellar/stellar-sdk';
import { getNetworkPassphrase, getRpcClient, type FacilitatorStellarSigner } from '@x402/stellar';
import { ExactStellarScheme } from '@x402/stellar/exact/facilitator';
import { systemClock, type Clock } from '../../../../channels/core/channel-pool.js';
import type { SettlementContexts } from '../../channels/settlement-context.js';
import { hasSourcePreconditions } from '../source-preconditions.js';
import { isZeroSettlement, zeroSettlement } from '../zero-settlement.js';
import { MIN_INCLUSION_FEE_STROOPS } from '../../fees/fee-bump-bid.js';
import { classifyExactResult } from './exact-outcome.js';

const PRECONDITIONS_REASON = 'invalid_exact_stellar_payload_preconditions';

/** False when the transaction cannot be read: upstream's own verification rejects it then. */
function setsSourcePreconditions(payload: PaymentPayload, network: Network): boolean {
  const transactionXdr = (payload.payload as { transaction?: unknown })?.transaction;
  if (typeof transactionXdr !== 'string') return false;
  try {
    return hasSourcePreconditions(new Transaction(transactionXdr, getNetworkPassphrase(network)));
  } catch {
    return false;
  }
}

export interface ExactChannelSchemeOptions {
  rpcConfig: { url: string };
  maxResourceFeeStroops: number;
  feeBumpSigner: FacilitatorStellarSigner;
  contexts: SettlementContexts;
  clock?: Clock;
}

/**
 * Upstream `exact`, settling on a channel leased from the shared pool. Upstream fixes its signer
 * list at construction, so a lease that brings an address it has not seen rebuilds it with that
 * signer added; settlements already running keep the instance they started with. `/supported`
 * advertises no signer for `exact`, where upstream lists every channel and the fee payer.
 */
export class ExactChannelScheme implements SchemeNetworkFacilitator {
  readonly scheme: string;
  readonly caipFamily: string;
  private readonly channels = new Map<string, FacilitatorStellarSigner>();
  private upstream: ExactStellarScheme;
  private readonly clock: Clock;

  constructor(private readonly options: ExactChannelSchemeOptions) {
    this.clock = options.clock ?? systemClock;
    this.upstream = this.buildUpstream();
    this.scheme = this.upstream.scheme;
    this.caipFamily = this.upstream.caipFamily;
  }

  getExtra(network: Network): Record<string, unknown> | undefined {
    return this.upstream.getExtra(network);
  }

  getSigners(_network: string): string[] {
    return [];
  }

  async verify(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<VerifyResponse> {
    if (setsSourcePreconditions(payload, requirements.network)) {
      return { isValid: false, invalidReason: PRECONDITIONS_REASON };
    }
    return this.upstream.verify(payload, requirements);
  }

  /**
   * Leases before calling upstream, whose synchronous `selectSigner` cannot wait on the store, and
   * reports the outcome to the settlement context. Throws the pool's errors when no channel leases.
   */
  async settle(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<SettleResponse> {
    const { network } = requirements;
    if (setsSourcePreconditions(payload, network)) {
      return { success: false, network, transaction: '', errorReason: PRECONDITIONS_REASON };
    }
    if (isZeroSettlement(requirements)) return this.settleZero(payload, requirements);
    const context = this.options.contexts.get();
    const lease = await context.acquire();
    const result = await this.upstreamWith(lease.signer).settle(payload, requirements);
    context.outcome = await classifyExactResult(result, context.selectedForSigning, {
      getTransaction: (hash) =>
        getRpcClient(requirements.network, this.options.rpcConfig).getTransaction(hash),
      nowMs: this.clock.now(),
      maxTimeoutSeconds: requirements.maxTimeoutSeconds,
    });
    return result;
  }

  /**
   * A zero `exact` payment moves nothing, so it is verified and answered without leasing, signing
   * or sending. The Buyer signed `transfer(…, 0)`, so the authorization cannot pay more later.
   */
  private async settleZero(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<SettleResponse> {
    const verified = await this.upstream.verify(payload, requirements);
    if (verified.isValid) return zeroSettlement(requirements.network, verified.payer);
    const errorReason = verified.invalidReason ?? 'verification_failed';
    return { success: false, network: requirements.network, transaction: '', errorReason };
  }

  private upstreamWith(signer: FacilitatorStellarSigner): ExactStellarScheme {
    if (!this.channels.has(signer.address)) {
      this.channels.set(signer.address, signer);
      this.upstream = this.buildUpstream();
    }
    return this.upstream;
  }

  private buildUpstream(): ExactStellarScheme {
    const { rpcConfig, maxResourceFeeStroops, feeBumpSigner, contexts } = this.options;
    // Upstream needs one signer before any channel is leased. The fee payer stands in: it is
    // already in upstream's safety checks, and `selectSigner` never returns it.
    const signers = this.channels.size > 0 ? [...this.channels.values()] : [feeBumpSigner];
    // Upstream caps resource fee plus its inner bid; with the inner bid at the minimum, this caps
    // the resource fee alone. The fee payer's signer sets the fee-bump's own bid.
    return new ExactStellarScheme(signers, {
      rpcConfig,
      inclusionFeeStroops: MIN_INCLUSION_FEE_STROOPS,
      maxTransactionFeeStroops: maxResourceFeeStroops + MIN_INCLUSION_FEE_STROOPS,
      feeBumpSigner,
      selectSigner: contexts.selectSigner,
    });
  }
}
