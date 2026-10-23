import { PGlite, types } from '@electric-sql/pglite';
import { PGliteDialect } from 'kysely-pglite-dialect';
import { createDatabase } from '../src/common/database/database.js';
import { migrateToLatest } from '../src/common/database/migrate.js';

/**
 * `bigint` columns read as JS `bigint` at every size, matching `postgresDialect`; PGlite alone
 * returns a `number` for values that fit one.
 */
const parsers = { [types.INT8]: (value: string) => BigInt(value) };

let migrated: Promise<File | Blob> | undefined;

/** The data directory of a freshly migrated database, built once per test worker. */
function migratedDataDir(): Promise<File | Blob> {
  migrated ??= (async () => {
    const pglite = new PGlite();
    await migrateToLatest(createDatabase(new PGliteDialect(pglite)));
    const dataDir = await pglite.dumpDataDir('none');
    await pglite.close();
    return dataDir;
  })();
  return migrated;
}

/**
 * A migrated, in-process PostgreSQL (PGlite) database of its own; no server or network needed.
 * Each one starts from the same migrated data directory, so tests never see each other's rows.
 */
export async function createTestDatabase() {
  const pglite = new PGlite({ loadDataDir: await migratedDataDir(), parsers });
  return createDatabase(new PGliteDialect(pglite));
}

/** A database whose every query fails, as when PostgreSQL cannot be reached. */
export async function createUnreachableTestDatabase() {
  const pglite = new PGlite();
  await pglite.close();
  return createDatabase(new PGliteDialect(pglite));
}
