import { x402Facilitator } from '@x402/core/facilitator';
import { getNetworkPassphrase, getRpcClient } from '@x402/stellar';
import type {
  PaymentPayload,
  PaymentRequirements,
  SettleResponse,
  VerifyResponse,
} from '@x402/core/types';
import type {
  ChannelPoolConfig,
  FacilitatorConfig,
} from '../../../../config/facilitator.config.js';
import type { Logger } from '../../../../common/logger.js';
import {
  ChannelsBusyError,
  ChannelStoreUnavailableError,
  systemClock,
  type ChannelPool,
  type Clock,
} from '../../../channels/core/channel-pool.js';
import type { SubmissionOutcome } from '../../../channels/core/transaction-pipeline.js';
import { SettlementContext, SettlementContexts } from '../channels/settlement-context.js';
import { createExactScheme } from '../schemes/exact/create-exact-scheme.js';
import type { KmsSigningClient } from '../../../channels/kms/kms-signer.js';
import { loadSigners, type SignerSetup } from '../schemes/signers.js';
import { createUptoScheme } from '../schemes/upto/create-upto-scheme.js';
import type { Caller } from '../../../credentials/caller.js';
import type { SettlementJournal } from '../persistence/settlement-journal.js';
import { FeeBumpBid } from '../fees/fee-bump-bid.js';
import { withFeeBumpBid } from '../fees/priced-fee-payer.js';

export interface PaymentEngine {
  verify(payload: PaymentPayload, requirements: PaymentRequirements): Promise<VerifyResponse>;
  /** `caller` is the Resource Server the settlement is recorded under. */
  settle(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
    caller: Caller,
  ): Promise<SettleResponse>;
  supported(): ReturnType<x402Facilitator['getSupported']>;
}

function createLoggedFacilitator(log: Logger): x402Facilitator {
  // Verification is logged by `StellarPaymentEngine.verify`: upstream sends a rejected result to
  // `onVerifyFailure` as a generic Error, which would hide its reason.
  return new x402Facilitator()
    .onAfterSettle(async ({ requirements, result }) => {
      log.info('payment_settled', {
        network: requirements.network,
        scheme: requirements.scheme,
        success: result.success,
        payer: result.payer,
        transaction: result.transaction,
      });
    })
    .onSettleFailure(async ({ requirements, error }) => {
      log.warn('payment_settle_failed', {
        network: requirements.network,
        scheme: requirements.scheme,
        errorName: error.name,
      });
    });
}

function logEngineReady(log: Logger, config: FacilitatorConfig, signers: SignerSetup): void {
  log.info('facilitator_engine_ready', {
    network: config.network,
    signing: signers.signing,
    feeBumpAddress: signers.feeBumpSigner.address,
  });
}

/** The reason both schemes return, instead of throwing, when verification itself failed. */
const UNEXPECTED_VERIFY_ERROR = 'unexpected_verify_error';

/**
 * Reasons reported after a channel was selected but before anything was broadcast, each with the
 * event it is logged under.
 */
const NOT_SENT_FAILURES: ReadonlyMap<string, string> = new Map([
  ['settle_exact_stellar_transaction_signing_failed', 'settlement_signing_failed'],
  ['settle_exact_stellar_fee_bump_signing_failed', 'settlement_signing_failed'],
  ['settle_upto_signing_failed', 'settlement_signing_failed'],
  ['settle_upto_transaction_build_failed', 'settlement_build_failed'],
]);

type SettlementResult = 'settled' | 'pending' | 'channel_unavailable' | 'failed';

const CHANNEL_UNAVAILABLE_REASONS: ReadonlySet<string> = new Set([
  'settle_exact_stellar_channel_unavailable',
  'settle_upto_channel_unavailable',
]);

/** How the settlement ended for the client, as the settlement log reports it. */
function settlementResult(response: SettleResponse): SettlementResult {
  if (response.success) return 'settled';
  const reason = response.errorReason ?? '';
  if (CHANNEL_UNAVAILABLE_REASONS.has(reason)) return 'channel_unavailable';
  return reason.startsWith('settlement_pending') ? 'pending' : 'failed';
}

/** The pool-full code per scheme, also returned when the store cannot be reached. */
function channelUnavailableReason(requirements: PaymentRequirements): string {
  return requirements.scheme === 'upto'
    ? 'settle_upto_channel_unavailable'
    : 'settle_exact_stellar_channel_unavailable';
}

/**
 * How long a lease lasts if its holder never finishes it: long enough for verification and for
 * upstream `exact`'s poll loop, whose sleeps and RPC round trips outrun `maxTimeoutSeconds`.
 */
export function leaseTtlMs(maxTimeoutSeconds: number, pool: ChannelPoolConfig): number {
  const pollMs = maxTimeoutSeconds * 1000 * (1 + pool.leasePollOverheadPct / 100);
  return pool.leaseVerifyBudgetMs + Math.ceil(pollMs) + pool.leaseMarginMs;
}

function failure(requirements: PaymentRequirements, errorReason: string, transaction = '') {
  return { success: false, network: requirements.network, transaction, errorReason };
}

/**
 * The answer to a broadcast the scheme did not report as settled, from what the pipeline saw: a
 * transaction read as included is final either way; anything else is pending, never failed.
 */
function broadcastResponse(
  result: SettleResponse,
  outcome: SubmissionOutcome,
  amount: string,
): SettleResponse {
  if (outcome.kind === 'included' && outcome.successful) {
    return { ...result, success: true, errorReason: undefined, amount };
  }
  if (outcome.kind === 'included') return { ...result, errorReason: 'invalid_transaction_state' };
  const errorReason = result.transaction ? 'settlement_pending' : 'settlement_pending_unknown';
  return { ...result, errorReason };
}

function isPoolError(error: unknown): error is ChannelsBusyError | ChannelStoreUnavailableError {
  return error instanceof ChannelsBusyError || error instanceof ChannelStoreUnavailableError;
}

export interface PaymentEngineDeps {
  pool: ChannelPool;
  /** Records each settlement before broadcast; its guard wraps the fee payer, which signs last. */
  journal: SettlementJournal;
  /** Replaces the AWS client; tests pass an in-memory KMS. */
  kms?: KmsSigningClient;
  clock?: Clock;
}

/**
 * Settles each payment on a channel leased from the shared pool, and ends the lease by what the
 * transaction can still do: at once if nothing was sent, after a cooldown once included or
 * rejected, and only when it can no longer be included if the outcome is unknown.
 */
export class StellarPaymentEngine implements PaymentEngine {
  private readonly contexts = new SettlementContexts();
  private readonly facilitator: x402Facilitator;
  private readonly clock: Clock;

  constructor(
    private readonly config: FacilitatorConfig,
    private readonly log: Logger,
    loaded: SignerSetup,
    private readonly deps: PaymentEngineDeps,
  ) {
    this.clock = deps.clock ?? systemClock;
    const rpcConfig = { url: config.rpcUrl };
    // The fee payer signs last on both schemes, so pricing it prices every settlement, and the
    // journal's guard records the priced envelope before it is broadcast.
    const priced = withFeeBumpBid(
      loaded.feeBumpSigner,
      new FeeBumpBid({
        stats: getRpcClient(config.network, rpcConfig),
        multiplier: config.feeBumpBid.multiplier,
        capStroops: config.feeBumpBid.maxBidStroops,
        log,
      }),
      getNetworkPassphrase(config.network),
    );
    const signers = { ...loaded, feeBumpSigner: deps.journal.guardFinalSigner(priced) };
    const schemeOptions = {
      rpcConfig,
      maxResourceFeeStroops: config.maxResourceFeeStroops,
      contexts: this.contexts,
    };
    const exact = createExactScheme(signers, { ...schemeOptions, clock: this.clock });
    logEngineReady(log, config, signers);

    this.facilitator = createLoggedFacilitator(log);
    this.facilitator.register(config.network, exact);
    const upto = createUptoScheme(config, signers, { ...schemeOptions, log });
    if (upto) {
      this.facilitator.register(config.network, upto);
      log.info('facilitator_upto_ready', {
        network: config.network,
        settlementContract: config.uptoKernelContract,
      });
    }
  }

  /**
   * Logs every answer, a rejection with its reason. A scheme reports its own internal failure, such
   * as an RPC error, as `unexpected_verify_error` rather than throwing; that and a throw (by error
   * name only) are logged as failures at warn.
   */
  async verify(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<VerifyResponse> {
    const fields = { network: requirements.network, scheme: requirements.scheme };
    let result: VerifyResponse;
    try {
      result = await this.facilitator.verify(payload, requirements);
    } catch (error) {
      this.log.warn('payment_verify_failed', {
        ...fields,
        errorName: error instanceof Error ? error.name : 'unknown',
      });
      throw error;
    }
    if (result.invalidReason === UNEXPECTED_VERIFY_ERROR) {
      this.log.warn('payment_verify_failed', { ...fields, invalidReason: result.invalidReason });
      return result;
    }
    this.log.info('payment_verified', {
      ...fields,
      valid: result.isValid,
      ...(result.isValid
        ? {}
        : { invalidReason: result.invalidReason, invalidMessage: result.invalidMessage }),
      payer: result.payer,
    });
    return result;
  }

  supported(): ReturnType<x402Facilitator['getSupported']> {
    return this.facilitator.getSupported();
  }

  /** Runs one settlement and writes its settlement log line, whichever way it ends. */
  async settle(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<SettleResponse> {
    const context = this.contextFor(requirements);
    try {
      const response = await this.runSettlement(payload, requirements, context);
      this.logSettlement(requirements, context, response);
      return response;
    } catch (error) {
      this.logSettlement(requirements, context, undefined, error);
      throw error;
    }
  }

  /** The context a scheme leases through: the pool and this payment's lease TTL. */
  private contextFor(requirements: PaymentRequirements): SettlementContext {
    const pool = this.config.channelPool;
    const context: SettlementContext = new SettlementContext({
      acquire: async () => {
        const startedAt = this.clock.now();
        try {
          return await this.deps.pool.acquire({
            waitMs: pool.acquireWaitMs,
            ttlMs: leaseTtlMs(requirements.maxTimeoutSeconds, pool),
          });
        } finally {
          context.acquireWaitMs += this.clock.now() - startedAt;
        }
      },
    });
    return context;
  }

  /** The outcome when the scheme reported none: it failed before leasing, or threw. */
  private fallbackOutcome(
    context: SettlementContext,
    requirements: PaymentRequirements,
  ): SubmissionOutcome {
    if (!context.lease || !context.selectedForSigning) return { kind: 'not-sent' };
    const validUntilMs = this.clock.now() + requirements.maxTimeoutSeconds * 1000;
    return { kind: 'unknown', validUntilMs };
  }

  /**
   * The outcome the lease ends with. A refused envelope can be resent until it expires, so its
   * channel keeps that sequence like any outcome still able to land.
   */
  private leaseOutcome(
    context: SettlementContext,
    requirements: PaymentRequirements,
  ): SubmissionOutcome {
    const outcome = context.outcome ?? this.fallbackOutcome(context, requirements);
    if (outcome.kind !== 'rejected') return outcome;
    const validUntilMs = this.clock.now() + requirements.maxTimeoutSeconds * 1000;
    return { kind: 'unknown', validUntilMs };
  }

  private logNotSent(result: SettleResponse, context: SettlementContext): void {
    const errorReason = result.errorReason ?? '';
    const event = NOT_SENT_FAILURES.get(errorReason);
    if (event) this.log.warn(event, { channel: context.lease?.address, errorReason });
  }

  private logSettlement(
    requirements: PaymentRequirements,
    context: SettlementContext,
    response: SettleResponse | undefined,
    error?: unknown,
  ): void {
    this.log.info('settlement_completed', {
      network: requirements.network,
      scheme: requirements.scheme,
      channel: context.lease?.address,
      result: response ? settlementResult(response) : 'error',
      errorReason: response?.errorReason,
      errorName: error instanceof Error ? error.name : undefined,
      txHash: response?.transaction || undefined,
      acquireWaitMs: context.acquireWaitMs,
    });
  }

  private async runSettlement(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
    context: SettlementContext,
  ): Promise<SettleResponse> {
    let result: SettleResponse;
    try {
      result = await this.contexts.run(context, () =>
        this.facilitator.settle(payload, requirements),
      );
    } catch (error) {
      return this.settleThrew(error, context, requirements);
    }
    const outcome = this.leaseOutcome(context, requirements);
    await context.lease?.finish(outcome);
    if (result.success || outcome.kind === 'not-sent') {
      this.logNotSent(result, context);
      return result;
    }
    return broadcastResponse(result, outcome, requirements.amount);
  }

  private async settleThrew(
    error: unknown,
    context: SettlementContext,
    requirements: PaymentRequirements,
  ): Promise<SettleResponse> {
    if (isPoolError(error)) {
      this.logChannelUnavailable(error, requirements);
      return failure(requirements, channelUnavailableReason(requirements));
    }
    const outcome = this.leaseOutcome(context, requirements);
    await context.lease?.finish(outcome);
    if (outcome.kind === 'not-sent') throw error;
    return failure(requirements, 'settlement_pending_unknown');
  }

  private logChannelUnavailable(
    error: ChannelsBusyError | ChannelStoreUnavailableError,
    requirements: PaymentRequirements,
  ): void {
    const fields = { scheme: requirements.scheme, network: requirements.network };
    if (error instanceof ChannelsBusyError) {
      this.log.warn('channel_pool_exhausted', {
        ...fields,
        waitMs: this.config.channelPool.acquireWaitMs,
      });
    } else {
      this.log.warn('settlement_channel_store_unavailable', fields);
    }
  }
}

export async function createStellarPaymentEngine(
  config: FacilitatorConfig,
  log: Logger,
  deps: PaymentEngineDeps,
): Promise<PaymentEngine> {
  const signers = await loadSigners(config, { log, kms: deps.kms });
  return new StellarPaymentEngine(config, log, signers, deps);
}
