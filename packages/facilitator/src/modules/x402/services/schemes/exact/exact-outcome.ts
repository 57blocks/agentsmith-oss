import type { SettleResponse } from '@x402/core/types';
import type { SubmissionOutcome } from '../../../../channels/core/transaction-pipeline.js';

/** Upstream reasons for a failure after the channel was selected but before anything was sent. */
const NOT_SENT_REASONS: ReadonlySet<string> = new Set([
  'settle_exact_stellar_signer_selection_failed',
  'settle_exact_stellar_transaction_signing_failed',
  'settle_exact_stellar_fee_bump_signing_failed',
]);

const SUBMISSION_REFUSED = 'settle_exact_stellar_transaction_submission_failed';
const CONFIRMATION_FAILED = 'settle_exact_stellar_transaction_failed';

export interface ExactOutcomeDeps {
  /** Read once for a hash upstream could not confirm; `rpc.Server` satisfies it. */
  getTransaction(hash: string): Promise<{ status: string }>;
  nowMs: number;
  maxTimeoutSeconds: number;
}

/**
 * What an upstream `exact` settlement can still do to its channel. Upstream reports an on-chain
 * failure and an exhausted confirmation wait with the same reason, so that case reads the hash
 * once; any other error after selection may have been broadcast and is unknown.
 */
export async function classifyExactResult(
  result: SettleResponse,
  selectedForSigning: boolean,
  deps: ExactOutcomeDeps,
): Promise<SubmissionOutcome> {
  if (!selectedForSigning) return { kind: 'not-sent' };
  const hash = result.transaction || undefined;
  if (result.success && hash) return { kind: 'included', hash, successful: true };
  const reason = result.errorReason ?? '';
  if (!hash && NOT_SENT_REASONS.has(reason)) return { kind: 'not-sent' };
  if (!hash && reason === SUBMISSION_REFUSED) return { kind: 'rejected', status: reason };
  // Upstream sets the transaction's timeout to `maxTimeoutSeconds` before sending it.
  const validUntilMs = deps.nowMs + deps.maxTimeoutSeconds * 1000;
  const unknown: SubmissionOutcome = { kind: 'unknown', hash, validUntilMs };
  if (!hash || reason !== CONFIRMATION_FAILED) return unknown;
  try {
    const { status } = await deps.getTransaction(hash);
    if (status === 'FAILED') return { kind: 'included', hash, successful: false };
    if (status === 'SUCCESS') return { kind: 'included', hash, successful: true };
  } catch {
    // An unreadable status proves nothing; the channel is held as for any unknown outcome.
  }
  return unknown;
}
