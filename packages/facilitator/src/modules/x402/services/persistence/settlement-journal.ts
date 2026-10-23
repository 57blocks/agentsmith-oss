import { AsyncLocalStorage } from 'node:async_hooks';
import { FeeBumpTransaction, TransactionBuilder } from '@stellar/stellar-sdk';
import type { FacilitatorStellarSigner } from '@x402/stellar';
import type { Logger } from '../../../../common/logger.js';
import type { Settlement } from '../../../../models/x402/settlement.model.js';
import type {
  PreparedSettlement,
  SettlementRepository,
} from '../../repositories/settlement.repository.js';

/** Frees a channel sequence an earlier pending row holds, if the chain proves it finished. */
export type SequenceRelease = (channelAccountAddress: string, sequence: bigint) => Promise<boolean>;

/** What a settlement is before its envelope exists; the envelope supplies the rest. */
export type SettlementDraft = Omit<
  PreparedSettlement,
  | 'feePayerAddress'
  | 'channelAccountAddress'
  | 'channelAccountSequence'
  | 'signedXdr'
  | 'txHash'
  | 'validUntil'
>;

export type JournalOutcome =
  /** Stored as `pending`; the envelope went on to be broadcast. */
  | { kind: 'recorded'; settlement: Settlement }
  /** Another request recorded this authorization first; nothing was broadcast. */
  | { kind: 'duplicate'; settlement: Settlement }
  /** Storage failed; nothing was broadcast. */
  | { kind: 'store-failed' };

interface Entry {
  draft: SettlementDraft;
  outcome?: JournalOutcome;
}

const NOT_RECORDED = { message: 'settlement not recorded; refusing to broadcast', code: -1 };

/**
 * Records a settlement between its last signature and its broadcast. The fee payer signs the
 * fee-bump last on both schemes — upstream `exact` and the `upto` pipeline — so a guarded fee payer
 * returns its signature only after the row is stored, and an envelope it refuses to return is
 * never sent.
 */
export class SettlementJournal {
  private readonly current = new AsyncLocalStorage<Entry>();

  constructor(
    private readonly settlements: SettlementRepository,
    private readonly networkPassphrase: string,
    private readonly log: Logger,
    private readonly releaseSequence?: SequenceRelease,
  ) {}

  /** Runs `work` with `draft` as the settlement any guarded signature inside it records. */
  async run<T>(
    draft: SettlementDraft,
    work: () => Promise<T>,
  ): Promise<{ result: T; outcome?: JournalOutcome }> {
    const entry: Entry = { draft };
    const result = await this.current.run(entry, work);
    return { result, outcome: entry.outcome };
  }

  guardFinalSigner(signer: FacilitatorStellarSigner): FacilitatorStellarSigner {
    return {
      ...signer,
      signTransaction: async (xdr, options) => {
        const signed = await signer.signTransaction(xdr, options);
        const entry = this.current.getStore();
        if (!entry || signed.error || !signed.signedTxXdr) return signed;
        entry.outcome = await this.record(entry.draft, signed.signedTxXdr);
        if (entry.outcome.kind === 'recorded') return signed;
        return { ...signed, signedTxXdr: '', error: NOT_RECORDED };
      },
    };
  }

  private async record(draft: SettlementDraft, signedXdr: string): Promise<JournalOutcome> {
    try {
      const envelope = TransactionBuilder.fromXDR(signedXdr, this.networkPassphrase);
      if (!(envelope instanceof FeeBumpTransaction)) {
        throw new Error('the final signature is not a fee-bump transaction');
      }
      const inner = envelope.innerTransaction;
      const maxTime = Number(inner.timeBounds?.maxTime ?? 0);
      if (maxTime <= 0) throw new Error('a settlement transaction must have an upper time bound');
      const { settlement, inserted } = await this.insert({
        ...draft,
        feePayerAddress: envelope.feeSource,
        channelAccountAddress: inner.source,
        channelAccountSequence: BigInt(inner.sequence),
        signedXdr: envelope.toEnvelope().toXDR(),
        txHash: envelope.hash(),
        validUntil: new Date(maxTime * 1000),
      });
      return inserted ? { kind: 'recorded', settlement } : { kind: 'duplicate', settlement };
    } catch (error) {
      this.log.error('settlement_store_failed', {
        errorName: error instanceof Error ? error.name : 'unknown',
      });
      return { kind: 'store-failed' };
    }
  }

  /**
   * Inserts the row. A failure because an earlier pending row still holds the same channel
   * sequence is retried once, after the chain proves that row finished.
   */
  private async insert(prepared: PreparedSettlement) {
    try {
      return await this.settlements.insertPrepared(prepared);
    } catch (error) {
      const { channelAccountAddress, channelAccountSequence } = prepared;
      if (!(await this.releaseSequence?.(channelAccountAddress, channelAccountSequence)))
        throw error;
      return this.settlements.insertPrepared(prepared);
    }
  }
}
