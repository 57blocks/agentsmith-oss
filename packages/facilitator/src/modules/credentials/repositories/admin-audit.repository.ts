import { Inject, Injectable } from '@nestjs/common';
import type { Kysely } from 'kysely';
import { DATABASE } from '../../../common/tokens.js';
import type { AdminAction } from '../../../models/credentials/admin-audit.model.js';
import type { Database } from '../../../models/database.js';

export interface AdminAuditRecord {
  actor: string;
  action: AdminAction;
  resourceServerId: string;
  credentialId: string;
}

/** Appends admin actions; there is no update or delete. */
@Injectable()
export class AdminAuditRepository {
  constructor(@Inject(DATABASE) private readonly db: Kysely<Database>) {}

  async record(entry: AdminAuditRecord): Promise<void> {
    await this.db.insertInto('adminAudit').values(entry).execute();
  }
}
