import type { ColumnType, Generated, Selectable } from 'kysely';

export type AdminAction = 'issue_key' | 'revoke_key';

/** One admin action on a Resource Server's keys. Rows are only ever inserted. */
export interface AdminAuditTable {
  id: Generated<string>;
  /** The admin's name from `ADMIN_API_KEYS`. */
  actor: string;
  action: AdminAction;
  resourceServerId: string;
  credentialId: string | null;
  createdAt: ColumnType<Date, never, never>;
}

export type AdminAuditEntry = Selectable<AdminAuditTable>;
