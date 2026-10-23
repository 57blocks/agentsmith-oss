import type { Transaction } from '@stellar/stellar-sdk';

/**
 * Whether the Buyer transaction sets a precondition beyond its time bounds. Both schemes rebuild
 * the payment on a channel and would carry it over: the sequence and signer conditions are then
 * checked against the channel, which fails them, and ledger bounds can close before settlement.
 * Zero sequence age and gap are the XDR defaults, not a condition.
 */
export function hasSourcePreconditions(transaction: Transaction): boolean {
  return (
    transaction.ledgerBounds !== undefined ||
    transaction.minAccountSequence !== undefined ||
    (transaction.minAccountSequenceAge ?? 0n) > 0n ||
    (transaction.minAccountSequenceLedgerGap ?? 0) > 0 ||
    (transaction.extraSigners?.length ?? 0) > 0
  );
}
