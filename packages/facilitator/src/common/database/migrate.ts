import type { Kysely } from 'kysely';
import { Migrator } from 'kysely/migration';
import { migrations } from '../../migrations/index.js';
import { createDatabase, postgresDialect } from './database.js';

/**
 * Applies every pending migration in order and returns the names applied. Runs without the
 * CamelCasePlugin so migrations name tables and columns exactly as they exist in SQL.
 */
export async function migrateToLatest<DB>(db: Kysely<DB>): Promise<string[]> {
  const migrator = new Migrator({
    db: db.withoutPlugins(),
    provider: { getMigrations: async () => migrations },
  });
  const { error, results = [] } = await migrator.migrateToLatest();
  const failed = results.find((result) => result.status === 'Error');
  if (error || failed) {
    throw new Error(`migration ${failed?.migrationName ?? 'run'} failed`, { cause: error });
  }
  return results.map((result) => result.migrationName);
}

/** Connects to `databaseUrl`, applies pending migrations, and closes. Throws if either fails. */
export async function migrateDatabase(databaseUrl: string): Promise<string[]> {
  const db = createDatabase(postgresDialect(databaseUrl));
  try {
    return await migrateToLatest(db);
  } finally {
    await db.destroy();
  }
}
