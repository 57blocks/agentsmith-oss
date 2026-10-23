import { FeeBumpTransaction, Transaction, TransactionBuilder } from '@stellar/stellar-sdk';
import { systemClock, type Clock } from './channel-pool.js';
import type { StellarSigner } from './stellar-signer.js';

/**
 * What a submission attempt can still do to its channel's sequence, which decides when the channel
 * may be leased again.
 */
export type SubmissionOutcome =
  /** Provably never left this process: nothing was broadcast. */
  | { kind: 'not-sent' }
  /** The RPC node refused it; the sequence was not consumed. */
  | { kind: 'rejected'; hash?: string; status: string }
  /** Its status was read by hash: on-chain, successful or not. */
  | { kind: 'included'; hash: string; successful: boolean }
  /** May still be included until `validUntilMs`; `hash` is absent when it was never learned. */
  | { kind: 'unknown'; hash?: string; validUntilMs: number };

/** The two RPC calls the pipeline makes; `rpc.Server` satisfies it. */
export interface PipelineRpc {
  sendTransaction(transaction: FeeBumpTransaction): Promise<{ status: string }>;
  getTransaction(hash: string): Promise<{ status: string }>;
}

/** A signer refused or failed to sign. Nothing was broadcast. */
export class TransactionSigningError extends Error {
  override name = 'TransactionSigningError';
}

export interface TransactionPipelineDeps {
  rpc: PipelineRpc;
  networkPassphrase: string;
  /** How long `submit` polls for the transaction's status before calling the outcome unknown. */
  confirmWaitMs: number;
  pollMs: number;
  clock?: Clock;
}

/**
 * `sendTransaction` statuses that mean the node took the transaction; `ERROR` and
 * `TRY_AGAIN_LATER` do not.
 */
const ACCEPTED = new Set(['PENDING', 'DUPLICATE']);

/**
 * Signs a channel transaction, wraps it in a fee-bump the fee payer pays for, submits it and waits
 * for its status. Independent of x402 and of which scheme built the transaction.
 */
export class TransactionPipeline {
  private readonly deps: Required<TransactionPipelineDeps>;

  constructor(deps: TransactionPipelineDeps) {
    this.deps = { clock: systemClock, ...deps };
  }

  /**
   * The channel signs `inner`; the fee payer signs a fee-bump around it. Only signing happens here,
   * so any failure throws `TransactionSigningError` and means nothing was sent.
   */
  async sponsor(
    inner: Transaction,
    channel: StellarSigner,
    feePayer: StellarSigner,
    inclusionFeeStroops: string,
  ): Promise<FeeBumpTransaction> {
    const { networkPassphrase } = this.deps;
    const signedInner = TransactionBuilder.fromXDR(
      await this.sign(channel, inner.toXDR()),
      networkPassphrase,
    );
    if (!(signedInner instanceof Transaction)) {
      throw new TransactionSigningError(`${channel.address} returned a fee-bump transaction`);
    }
    const feeBump = TransactionBuilder.buildFeeBumpTransaction(
      feePayer.address,
      inclusionFeeStroops,
      signedInner,
      networkPassphrase,
    );
    const signed = TransactionBuilder.fromXDR(
      await this.sign(feePayer, feeBump.toXDR()),
      networkPassphrase,
    );
    if (!(signed instanceof FeeBumpTransaction)) {
      throw new TransactionSigningError(
        `${feePayer.address} did not return a fee-bump transaction`,
      );
    }
    return signed;
  }

  /**
   * Submits and waits up to `confirmWaitMs`. The hash is computed before sending, so a send that
   * throws is still reconcilable. Never throws once `sendTransaction` was called; throws before it
   * only for an envelope without an upper time bound, whose channel could never be released.
   */
  async submit(envelope: FeeBumpTransaction): Promise<SubmissionOutcome> {
    const hash = envelope.hash().toString('hex');
    const validUntilMs = validUntilMsOf(envelope);
    let status: string;
    try {
      ({ status } = await this.deps.rpc.sendTransaction(envelope));
    } catch {
      // The request may have reached the node: the outcome is unknown, not a failure.
      return { kind: 'unknown', hash, validUntilMs };
    }
    if (!ACCEPTED.has(status)) return { kind: 'rejected', hash, status };
    return this.confirm(hash, validUntilMs);
  }

  private async confirm(hash: string, validUntilMs: number): Promise<SubmissionOutcome> {
    const { rpc, clock, confirmWaitMs, pollMs } = this.deps;
    const deadline = clock.now() + confirmWaitMs;
    for (;;) {
      const status = await rpc.getTransaction(hash).then(
        (result) => result.status,
        // An RPC error tells nothing about the transaction; keep polling until the wait ends.
        () => 'NOT_FOUND',
      );
      if (status === 'SUCCESS' || status === 'FAILED') {
        return { kind: 'included', hash, successful: status === 'SUCCESS' };
      }
      if (clock.now() >= deadline) return { kind: 'unknown', hash, validUntilMs };
      await clock.sleep(pollMs);
    }
  }

  private async sign(signer: StellarSigner, xdr: string): Promise<string> {
    const { networkPassphrase } = this.deps;
    let result;
    try {
      result = await signer.signTransaction(xdr, { networkPassphrase });
    } catch (error) {
      throw new TransactionSigningError(`${signer.address} failed to sign`, { cause: error });
    }
    if (result.error || !result.signedTxXdr) {
      throw new TransactionSigningError(
        `${signer.address} failed to sign: ${result.error?.message ?? 'no transaction returned'}`,
      );
    }
    if (result.signerAddress && result.signerAddress !== signer.address) {
      throw new TransactionSigningError(`${signer.address} was signed by ${result.signerAddress}`);
    }
    return result.signedTxXdr;
  }
}

/** The end of the inner transaction's validity window: after it, it can never be included. */
function validUntilMsOf(envelope: FeeBumpTransaction): number {
  const maxTime = Number(envelope.innerTransaction.timeBounds?.maxTime ?? 0);
  if (maxTime <= 0) {
    throw new Error('a channel transaction must have an upper time bound');
  }
  return maxTime * 1000;
}
