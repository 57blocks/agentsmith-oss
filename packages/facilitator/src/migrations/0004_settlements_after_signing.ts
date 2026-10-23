import { sql, type Kysely } from 'kysely';
import { SHARED_KEY_RESOURCE_SERVER_ID } from '../models/credentials/resource-server.model.js';

/**
 * A settlement row is now written once its final envelope is signed, so the transaction columns
 * are always present. The envelope is stored as plain XDR until encryption at rest is added, and
 * its validity is the transaction's upper time bound rather than a ledger.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`alter table settlements drop constraint settlements_transaction_complete`.execute(db);
  await sql`alter table settlements drop constraint settlements_outcome_has_transaction`.execute(
    db,
  );
  await sql`alter table settlements rename column signed_xdr_encrypted to signed_xdr`.execute(db);
  await sql`alter table settlements drop column valid_until_ledger`.execute(db);
  await sql`alter table settlements add column valid_until timestamptz`.execute(db);
  for (const column of [
    'channel_account_address',
    'channel_account_sequence',
    'signed_xdr',
    'tx_hash',
    'valid_until',
  ]) {
    await db.schema
      .alterTable('settlements')
      .alterColumn(column, (col) => col.setNotNull())
      .execute();
  }

  await sql`insert into resource_server (id, name, domain)
    values (${SHARED_KEY_RESOURCE_SERVER_ID}, 'Shared API key', 'shared-api-key.local')
    on conflict (id) do nothing`.execute(db);
}
