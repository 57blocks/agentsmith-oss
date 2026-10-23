import { sql, type Kysely, type RawBuilder } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  // Token and fee amounts in atomic units. Unconstrained numeric, so a fractional value is rejected
  // instead of being rounded the way numeric(39, 0) would; 39 digits hold any Stellar i128.
  await sql`create domain atomic_amount as numeric
    check (value >= 0 and scale(value) = 0 and value < 1e39)`.execute(db);
  await createTable(db);
  await addStateConstraints(db);
  await createIndexes(db);
}

async function createTable(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('settlements')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('resource_server_id', 'uuid', (col) =>
      col.notNull().references('resource_server.id'),
    )
    .addColumn('network', 'text', (col) => col.notNull())
    .addColumn('scheme', 'text', (col) => col.notNull().check(sql`scheme in ('exact', 'upto')`))
    .addColumn('asset', 'text', (col) => col.notNull())
    .addColumn('pay_to', 'text', (col) => col.notNull())
    .addColumn('payer', 'text', (col) => col.notNull())
    .addColumn('signature_digest', 'bytea', (col) =>
      col
        .notNull()
        .unique()
        .check(sql`octet_length(signature_digest) = 32`),
    )
    .addColumn('actual_amount', sql`atomic_amount`, (col) => col.notNull())
    .addColumn('fee_payer_address', 'text', (col) => col.notNull())
    .addColumn('channel_account_address', 'text')
    .addColumn('channel_account_sequence', 'bigint')
    .addColumn('signed_xdr_encrypted', 'bytea')
    .addColumn('tx_hash', 'bytea', (col) => col.unique().check(sql`octet_length(tx_hash) = 32`))
    .addColumn('valid_until_ledger', 'integer')
    .addColumn('status', 'text', (col) =>
      col
        .notNull()
        .defaultTo('pending')
        .check(sql`status in ('pending', 'success', 'failed', 'expired')`),
    )
    .addColumn('fee_charged', sql`atomic_amount`)
    .addColumn('send_tx_at', 'timestamptz')
    .addColumn('finished_at', 'timestamptz')
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn('updated_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .execute();
}

async function addStateConstraints(db: Kysely<unknown>): Promise<void> {
  const constraints: Array<[name: string, check: RawBuilder<unknown>]> = [
    // The final envelope is prepared as one unit: every transaction column, or none.
    [
      'settlements_transaction_complete',
      sql`num_nulls(channel_account_address, channel_account_sequence, signed_xdr_encrypted,
        tx_hash, valid_until_ledger) in (0, 5)`,
    ],
    // A broadcast, a final outcome and a charged fee all refer to a prepared transaction.
    [
      'settlements_outcome_has_transaction',
      sql`tx_hash is not null or (status = 'pending' and send_tx_at is null and fee_charged is null)`,
    ],
    ['settlements_finished_when_final', sql`(status = 'pending') = (finished_at is null)`],
  ];
  for (const [name, check] of constraints) {
    await db.schema.alterTable('settlements').addCheckConstraint(name, check).execute();
  }
}

async function createIndexes(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createIndex('settlements_resource_server_id_idx')
    .on('settlements')
    .column('resource_server_id')
    .execute();

  // Two unresolved transactions never hold the same channel sequence (OPS-1). An expired one never
  // consumed its sequence, so a later transaction may reuse it.
  await db.schema
    .createIndex('settlements_pending_channel_sequence_idx')
    .on('settlements')
    .columns(['channel_account_address', 'channel_account_sequence'])
    .unique()
    .where(sql<boolean>`status = 'pending' and channel_account_address is not null`)
    .execute();

  // The recovery worker scans prepared transactions whose outcome is still unknown.
  await db.schema
    .createIndex('settlements_unresolved_idx')
    .on('settlements')
    .column('updated_at')
    .where(sql<boolean>`status = 'pending' and tx_hash is not null`)
    .execute();
}
