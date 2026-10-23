import type { ColumnType, Generated, Selectable } from 'kysely';

export type SettlementScheme = 'exact' | 'upto';

/** Unknown until the chain shows `success` or `failed`, or the window has `expired`. */
export type SettlementStatus = 'pending' | 'success' | 'failed' | 'expired';

/**
 * One row per Buyer authorization, unique on its digest, written once the final envelope is signed
 * and before it is broadcast. A zero-usage `upto` row has no transaction: every
 * transaction field below is null, and it is final.
 */
export interface SettlementTable {
  id: Generated<string>;
  resourceServerId: string;
  network: string;
  scheme: SettlementScheme;
  asset: string;
  payTo: string;
  payer: string;
  /** SHA-256 of the Buyer's whole authorization entry XDR. */
  signatureDigest: Uint8Array;
  /** Atomic units of `asset`, as a decimal string. */
  actualAmount: string;
  feePayerAddress: string | null;
  channelAccountAddress: string | null;
  channelAccountSequence: bigint | null;
  /** Final signed fee-bump envelope XDR. Not yet encrypted at rest. */
  signedXdr: Uint8Array | null;
  /** SHA-256 transaction hash (32 bytes). */
  txHash: Uint8Array | null;
  /** The inner transaction's upper time bound: after it, the envelope can never be included. */
  validUntil: Date | null;
  status: ColumnType<SettlementStatus, SettlementStatus | undefined, SettlementStatus>;
  /** Confirmed network fee in stroops; null until reconciled. */
  feeCharged: string | null;
  /** When the envelope was handed to submission. */
  sendTxAt: Date | null;
  finishedAt: Date | null;
  createdAt: ColumnType<Date, never, never>;
  updatedAt: ColumnType<Date, never, Date>;
}

export type Settlement = Selectable<SettlementTable>;
