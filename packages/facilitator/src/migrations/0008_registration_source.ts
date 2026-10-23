import { sql, type Kysely } from 'kysely';

/**
 * One row per successful registration, keyed by a keyed digest of the source IP, so the
 * registration limit can be counted here when the channel store cannot be reached.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('registration_source')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('ip_digest', 'bytea', (col) => col.notNull().check(sql`length(ip_digest) = 32`))
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .execute();
  await db.schema
    .createIndex('registration_source_ip_digest_created_at')
    .on('registration_source')
    .columns(['ip_digest', 'created_at'])
    .execute();
}
