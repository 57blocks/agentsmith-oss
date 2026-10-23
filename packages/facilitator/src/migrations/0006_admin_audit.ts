import { sql, type Kysely } from 'kysely';

/** Append-only record of admin actions on keys: who, what, which server and key, when. */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('admin_audit')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('actor', 'text', (col) => col.notNull())
    .addColumn('action', 'text', (col) =>
      col.notNull().check(sql`action in ('issue_key', 'revoke_key')`),
    )
    .addColumn('resource_server_id', 'uuid', (col) =>
      col.notNull().references('resource_server.id'),
    )
    .addColumn('credential_id', 'uuid', (col) => col.references('api_credentials.id'))
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .execute();
}
