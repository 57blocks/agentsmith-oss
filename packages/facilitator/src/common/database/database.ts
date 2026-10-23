import { CamelCasePlugin, Kysely, PostgresDialect, type Dialect } from 'kysely';
import pg from 'pg';
import type { Database } from '../../models/database.js';

/** Builds the typed client over any Kysely dialect; tests pass an in-process PGlite dialect. */
export function createDatabase(dialect: Dialect): Kysely<Database> {
  return new Kysely<Database>({ dialect, plugins: [new CamelCasePlugin()] });
}

/** Reads `bigint` columns as JS `bigint`, matching PGlite; `pg` would return a string. */
const types = {
  getTypeParser: ((oid: number, format?: 'text' | 'binary') =>
    oid === pg.types.builtins.INT8
      ? BigInt
      : pg.types.getTypeParser(oid, format)) as typeof pg.types.getTypeParser,
};

export function postgresDialect(connectionString: string): Dialect {
  return new PostgresDialect({ pool: new pg.Pool({ connectionString, types }) });
}
