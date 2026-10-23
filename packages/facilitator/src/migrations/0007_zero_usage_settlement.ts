import { sql, type Kysely } from 'kysely';

const TRANSACTION_COLUMNS = [
  'fee_payer_address',
  'channel_account_address',
  'channel_account_sequence',
  'signed_xdr',
  'tx_hash',
  'valid_until',
] as const;

/**
 * A zero-usage `upto` settlement is recorded with no transaction, so its authorization cannot be
 * charged later. A row has every transaction column, or none and is a final zero `upto` closure.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  for (const column of TRANSACTION_COLUMNS) {
    await db.schema
      .alterTable('settlements')
      .alterColumn(column, (col) => col.dropNotNull())
      .execute();
  }
  // DDL takes no bind parameters, so the check is constant text built from the list above.
  const missing = `num_nulls(${TRANSACTION_COLUMNS.join(', ')})`;
  const check = `${missing} = 0 or (${missing} = ${TRANSACTION_COLUMNS.length}
    and actual_amount = 0 and status = 'success' and scheme = 'upto')`;
  await db.schema
    .alterTable('settlements')
    .addCheckConstraint('settlements_transaction_or_zero_usage', sql.raw(check))
    .execute();
}
