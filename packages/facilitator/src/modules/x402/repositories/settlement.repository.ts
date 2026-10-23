import { Inject, Injectable } from '@nestjs/common';
import { sql, type Kysely } from 'kysely';
import { DATABASE } from '../../../common/tokens.js';
import type { Database } from '../../../models/database.js';
import type {
  Settlement,
  SettlementScheme,
  SettlementStatus,
} from '../../../models/x402/settlement.model.js';

/** A settlement whose final envelope is signed and about to be broadcast. */
export interface PreparedSettlement {
  resourceServerId: string;
  network: string;
  scheme: SettlementScheme;
  asset: string;
  payTo: string;
  payer: string;
  signatureDigest: Uint8Array;
  actualAmount: string;
  feePayerAddress: string;
  channelAccountAddress: string;
  channelAccountSequence: bigint;
  signedXdr: Uint8Array;
  txHash: Uint8Array;
  validUntil: Date;
}

/** A zero-usage `upto` settlement: its terms only, since no transaction is sent. */
export type ZeroUsageSettlement = Omit<
  PreparedSettlement,
  | 'feePayerAddress'
  | 'channelAccountAddress'
  | 'channelAccountSequence'
  | 'signedXdr'
  | 'txHash'
  | 'validUntil'
>;

export type FinalStatus = Exclude<SettlementStatus, 'pending'>;

@Injectable()
export class SettlementRepository {
  constructor(@Inject(DATABASE) private readonly db: Kysely<Database>) {}

  /** Runs `work` with a repository bound to one database transaction. */
  transaction<T>(work: (repository: SettlementRepository) => Promise<T>): Promise<T> {
    return this.db.transaction().execute((trx) => work(new SettlementRepository(trx)));
  }

  findBySignatureDigest(signatureDigest: Uint8Array): Promise<Settlement | undefined> {
    return this.db
      .selectFrom('settlements')
      .selectAll()
      .where('signatureDigest', '=', signatureDigest)
      .executeTakeFirst();
  }

  /**
   * Inserts the signed settlement as `pending`. When another request already recorded the same
   * authorization, returns that row instead with `inserted: false`, and the caller must not
   * broadcast. Throws only when storage fails, which must also stop the broadcast.
   */
  async insertPrepared(
    settlement: PreparedSettlement,
  ): Promise<{ settlement: Settlement; inserted: boolean }> {
    const inserted = await this.db
      .insertInto('settlements')
      .values({ ...settlement, sendTxAt: sql<Date>`now()` })
      .onConflict((conflict) => conflict.column('signatureDigest').doNothing())
      .returningAll()
      .executeTakeFirst();
    if (inserted) return { settlement: inserted, inserted: true };

    const existing = await this.findBySignatureDigest(settlement.signatureDigest);
    if (!existing) throw new Error('settlement conflicted but was not found');
    return { settlement: existing, inserted: false };
  }

  /**
   * Stores a zero-usage `upto` settlement as final `success` with no transaction, so its
   * authorization cannot be settled again. Like `insertPrepared`, returns the first row with
   * `inserted: false` when the authorization is already recorded, and throws only when storage
   * fails.
   */
  async insertZeroUsage(
    settlement: ZeroUsageSettlement,
  ): Promise<{ settlement: Settlement; inserted: boolean }> {
    const inserted = await this.db
      .insertInto('settlements')
      .values({ ...settlement, status: 'success', finishedAt: sql<Date>`now()` })
      .onConflict((conflict) => conflict.column('signatureDigest').doNothing())
      .returningAll()
      .executeTakeFirst();
    if (inserted) return { settlement: inserted, inserted: true };

    const existing = await this.findBySignatureDigest(settlement.signatureDigest);
    if (!existing) throw new Error('settlement conflicted but was not found');
    return { settlement: existing, inserted: false };
  }

  /** The pending settlement whose transaction uses this channel sequence, if any. */
  findPendingBySequence(
    channelAccountAddress: string,
    channelAccountSequence: bigint,
  ): Promise<Settlement | undefined> {
    return this.db
      .selectFrom('settlements')
      .selectAll()
      .where('channelAccountAddress', '=', channelAccountAddress)
      .where('channelAccountSequence', '=', channelAccountSequence)
      .where('status', '=', 'pending')
      .executeTakeFirst();
  }

  /** Stamps another send of the stored envelope; false if the row is no longer pending. */
  async markSent(id: string, txHash: Uint8Array, sentAt: Date): Promise<boolean> {
    const result = await this.db
      .updateTable('settlements')
      .set({ sendTxAt: sentAt, updatedAt: sql<Date>`now()` })
      .where('id', '=', id)
      .where('txHash', '=', txHash)
      .where('status', '=', 'pending')
      .executeTakeFirst();
    return result.numUpdatedRows > 0n;
  }

  /** Records the outcome the chain proved for this transaction; false if already final. */
  async finish(
    id: string,
    txHash: Uint8Array,
    status: FinalStatus,
    feeCharged: string | null = null,
  ): Promise<boolean> {
    const result = await this.db
      .updateTable('settlements')
      .set({
        status,
        feeCharged,
        finishedAt: sql<Date>`now()`,
        updatedAt: sql<Date>`now()`,
      })
      .where('id', '=', id)
      .where('txHash', '=', txHash)
      .where('status', '=', 'pending')
      .executeTakeFirst();
    return result.numUpdatedRows > 0n;
  }
}
