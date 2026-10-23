import { Module, type DynamicModule } from '@nestjs/common';
import type { Kysely } from 'kysely';
import type { Database } from '../../models/database.js';
import { DATABASE } from '../tokens.js';

/**
 * Provides the app's one `Kysely<Database>` under the `DATABASE` token to every module. Its owner,
 * settlement persistence, closes it on shutdown.
 */
@Module({})
export class DatabaseModule {
  static register(db: Kysely<Database>): DynamicModule {
    return {
      module: DatabaseModule,
      global: true,
      providers: [{ provide: DATABASE, useValue: db }],
      exports: [DATABASE],
    };
  }
}
