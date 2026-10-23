import type { SettleResponse } from '@x402/core/types';
import type { Logger } from '../../../../common/logger.js';
import type { Settlement } from '../../../../models/x402/settlement.model.js';
import type {
  FinalStatus,
  SettlementRepository,
} from '../../repositories/settlement.repository.js';
import type { SettlementDraft } from './settlement-journal.js';

/** One `getTransaction` answer: the hash's status and the ledger close times the node covers. */
export interface TransactionLookup {
  status: string;
  /** Unix seconds. */
  latestLedgerCloseTime: number;
  /** Unix seconds; the node holds no transaction history before this. */
  oldestLedgerCloseTime: number;
}

/** Reads a transaction by hash on the deployment's network. */
export type TransactionStatusReader = (hash: string) => Promise<TransactionLookup>;

/** Sends a stored envelope (base64 XDR) to the network again; a refusal is not an error. */
export type EnvelopeSender = (envelopeXdr: string) => Promise<void>;

export interface PersistedSettlementsDeps {
  settlements: SettlementRepository;
  readStatus: TransactionStatusReader;
  sendTransaction: EnvelopeSender;
  log: Logger;
  /** Allowance for skew between the database clock and ledger close times. */
  historySkewMs: number;
  now?: () => number;
}

const MIN_RESEND_WAIT_MS = 2_000;
const MAX_RESEND_WAIT_MS = 30_000;

/** The wait before sending again equals the time since the row was written, so it doubles. */
function isResendDue(settlement: Settlement, nowMs: number): boolean {
  const lastSentMs = settlement.sendTxAt?.getTime();
  if (lastSentMs === undefined) return true;
  const sinceWrittenMs = lastSentMs - settlement.createdAt.getTime();
  const waitMs = Math.min(MAX_RESEND_WAIT_MS, Math.max(MIN_RESEND_WAIT_MS, sinceWrittenMs));
  return nowMs - lastSentMs >= waitMs;
}

/** A row with its transaction: every row except a zero-usage closure. */
type TransactionSettlement = Settlement & {
  txHash: Uint8Array;
  signedXdr: Uint8Array;
  validUntil: Date;
};

/** The schema gives every pending row a transaction; only a final zero closure has none. */
function withTransaction(settlement: Settlement): TransactionSettlement {
  const { txHash, signedXdr, validUntil } = settlement;
  if (!txHash || !signedXdr || !validUntil) throw new Error('settlement has no transaction');
  return { ...settlement, txHash, signedXdr, validUntil };
}

/** Not found yet, and the chain has not passed the envelope's `maxTime`: it can still land. */
function canStillLand(settlement: TransactionSettlement, lookup: TransactionLookup): boolean {
  return (
    lookup.status === 'NOT_FOUND' &&
    lookup.latestLedgerCloseTime * 1000 <= settlement.validUntil.getTime()
  );
}

/** Engine reasons that mean the chain included the transaction and it failed. */
const CONFIRMED_FAILURE = new Set(['invalid_transaction_state', 'settle_upto_transaction_failed']);

type Network = SettleResponse['network'];

/** Rows store the CAIP-2 network they were settled on; this proves the shape before narrowing. */
function asNetwork(value: string): Network {
  if (!/^[^:]+:[^:]+$/.test(value)) throw new Error('stored settlement has an invalid network');
  return value as Network;
}

/** The public hash, or `""` for a zero-usage settlement that sent no transaction. */
function hex(bytes: Uint8Array | null): string {
  return bytes ? Buffer.from(bytes).toString('hex') : '';
}

function responseFor(settlement: Settlement): SettleResponse {
  const { network, payer, actualAmount } = settlement;
  const base = { network: asNetwork(network), transaction: hex(settlement.txHash), payer };
  switch (settlement.status) {
    case 'success':
      return { ...base, success: true, amount: actualAmount };
    case 'pending':
      return { ...base, success: false, errorReason: 'settlement_pending' };
    case 'expired':
      // Proven never included and never includable: nothing was charged.
      return { ...base, success: false, errorReason: 'settlement_expired' };
    default:
      // Included and failed: the network fee was charged.
      return { ...base, success: false, errorReason: 'invalid_transaction_state' };
  }
}

/**
 * The final status the chain proves for a stored transaction, or undefined while it could still
 * land. `expired` needs both: the chain has closed a ledger after the envelope's `maxTime`, and
 * the node's history reaches back to when the row was written, before which the transaction could
 * not have been sent.
 */
export function provenOutcome(
  settlement: Pick<TransactionSettlement, 'validUntil' | 'createdAt'>,
  lookup: TransactionLookup,
  historySkewMs: number,
): FinalStatus | undefined {
  if (lookup.status === 'SUCCESS') return 'success';
  if (lookup.status === 'FAILED') return 'failed';
  if (lookup.status !== 'NOT_FOUND') return undefined;
  const cannotLand = lookup.latestLedgerCloseTime * 1000 > settlement.validUntil.getTime();
  const historyCovers =
    lookup.oldestLedgerCloseTime * 1000 <= settlement.createdAt.getTime() - historySkewMs;
  return cannotLand && historyCovers ? 'expired' : undefined;
}

/** A resent settle must come from the same server with the same terms. */
function sameTerms(settlement: Settlement, draft: SettlementDraft): boolean {
  return (
    settlement.resourceServerId === draft.resourceServerId &&
    settlement.network === draft.network &&
    settlement.scheme === draft.scheme &&
    settlement.asset === draft.asset &&
    settlement.payTo === draft.payTo &&
    settlement.actualAmount === draft.actualAmount
  );
}

/** Answers settles from stored rows and records what the engine learned. */
export class PersistedSettlements {
  private readonly settlements: SettlementRepository;
  private readonly now: () => number;

  constructor(private readonly deps: PersistedSettlementsDeps) {
    this.settlements = deps.settlements;
    this.now = deps.now ?? Date.now;
  }

  find(draft: SettlementDraft): Promise<Settlement | undefined> {
    return this.settlements.findBySignatureDigest(draft.signatureDigest);
  }

  /** The answer for a settle whose authorization is already stored; reconciles a pending one. */
  async answer(settlement: Settlement, draft: SettlementDraft): Promise<SettleResponse> {
    if (!sameTerms(settlement, draft)) {
      return {
        success: false,
        errorReason: 'settlement_amount_conflict',
        transaction: hex(settlement.txHash),
        network: asNetwork(draft.network),
      };
    }
    if (settlement.status !== 'pending') return responseFor(settlement);
    return responseFor(await this.resolvePending(settlement));
  }

  /**
   * Records a zero-usage `upto` settlement, which sends no transaction, so the authorization cannot
   * be charged later. A concurrent settle that recorded it first is answered from its row. Throws
   * when storage fails: the caller must not report success then.
   */
  async recordZeroUsage(draft: SettlementDraft, response: SettleResponse): Promise<SettleResponse> {
    const { settlement, inserted } = await this.settlements.insertZeroUsage(draft);
    return inserted ? response : this.answer(settlement, draft);
  }

  /**
   * Frees a channel sequence held by an earlier pending row once the chain proves that row
   * finished. True when no pending row holds it any more.
   */
  async releaseSequence(channelAccountAddress: string, sequence: bigint): Promise<boolean> {
    const holder = await this.settlements.findPendingBySequence(channelAccountAddress, sequence);
    if (!holder) return true;
    return (await this.resolvePending(holder)).status !== 'pending';
  }

  /** Records a final outcome the engine reported for the transaction it just broadcast. */
  async recordEngineResult(settlement: Settlement, result: SettleResponse): Promise<void> {
    const { txHash } = settlement;
    if (!txHash || result.transaction !== hex(txHash)) return;
    if (result.success) {
      await this.settlements.finish(settlement.id, txHash, 'success');
    } else if (CONFIRMED_FAILURE.has(result.errorReason ?? '')) {
      await this.settlements.finish(settlement.id, txHash, 'failed');
    }
  }

  /**
   * One read by hash. A status the chain proves finishes the row; one that can still land is sent
   * again once its backoff has passed. An unreadable node leaves the row as it is.
   */
  async resolvePending(settlement: Settlement): Promise<Settlement> {
    const pending = withTransaction(settlement);
    const lookup = await this.deps.readStatus(hex(pending.txHash)).catch(() => undefined);
    if (!lookup) return settlement;
    const final = provenOutcome(pending, lookup, this.deps.historySkewMs);
    if (final) return this.finishAs(pending, final);
    if (canStillLand(pending, lookup) && isResendDue(pending, this.now())) {
      await this.resend(pending);
    }
    return settlement;
  }

  /** A row another writer finished first is read back. */
  private async finishAs(
    settlement: TransactionSettlement,
    final: FinalStatus,
  ): Promise<Settlement> {
    if (await this.settlements.finish(settlement.id, settlement.txHash, final)) {
      return { ...settlement, status: final };
    }
    return (await this.settlements.findBySignatureDigest(settlement.signatureDigest)) ?? settlement;
  }

  /** Sends the stored envelope, unchanged. A failed send is retried after the next backoff. */
  private async resend(settlement: TransactionSettlement): Promise<void> {
    const envelopeXdr = Buffer.from(settlement.signedXdr).toString('base64');
    try {
      await this.deps.sendTransaction(envelopeXdr);
    } catch (error) {
      this.deps.log.warn('settlement_resend_failed', {
        errorName: error instanceof Error ? error.name : 'unknown',
      });
    }
    await this.settlements.markSent(settlement.id, settlement.txHash, new Date(this.now()));
  }
}
