import type { Kysely } from 'kysely';

/** Contact email given at registration. Nullable: the shared-key server predates registration. */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable('resource_server').addColumn('email', 'text').execute();
}
