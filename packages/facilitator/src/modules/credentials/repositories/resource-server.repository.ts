import { Inject, Injectable } from '@nestjs/common';
import { sql, type Kysely } from 'kysely';
import { DATABASE } from '../../../common/tokens.js';
import type {
  ResourceServer,
  ResourceServerStatus,
} from '../../../models/credentials/resource-server.model.js';
import type { Database } from '../../../models/database.js';

export interface NewResourceServer {
  name: string;
  domain: string;
  email?: string | null;
}

@Injectable()
export class ResourceServerRepository {
  constructor(@Inject(DATABASE) private readonly db: Kysely<Database>) {}

  create(server: NewResourceServer): Promise<ResourceServer> {
    return this.db
      .insertInto('resourceServer')
      .values(server)
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  list(): Promise<ResourceServer[]> {
    return this.db.selectFrom('resourceServer').selectAll().orderBy('createdAt').execute();
  }

  /**
   * Locks the server's row until the surrounding transaction ends. Returns its status, or
   * undefined if it does not exist.
   */
  lock(id: string): Promise<Pick<ResourceServer, 'status'> | undefined> {
    return this.db
      .selectFrom('resourceServer')
      .select('status')
      .where('id', '=', id)
      .forUpdate()
      .executeTakeFirst();
  }

  /** Returns the updated server, or undefined when no server has this id. */
  setStatus(id: string, status: ResourceServerStatus): Promise<ResourceServer | undefined> {
    return this.db
      .updateTable('resourceServer')
      .set({ status, updatedAt: sql<Date>`now()` })
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirst();
  }
}
