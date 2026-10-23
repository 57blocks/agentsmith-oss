import { sql, type Kysely } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('api_credentials')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('resource_server_id', 'uuid', (col) =>
      col.notNull().references('resource_server.id'),
    )
    .addColumn('secret_digest', 'bytea', (col) =>
      col
        .notNull()
        .unique()
        .check(sql`octet_length(secret_digest) = 32`),
    )
    .addColumn('expires_at', 'timestamptz')
    .addColumn('revoked_at', 'timestamptz')
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .execute();

  await db.schema
    .createIndex('api_credentials_resource_server_id_idx')
    .on('api_credentials')
    .column('resource_server_id')
    .execute();
}
