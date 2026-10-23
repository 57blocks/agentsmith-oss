import type { ColumnType, Generated, Selectable } from 'kysely';

export type ResourceServerStatus = 'active' | 'disabled';

/** Owns every settlement while authentication is one shared API key; seeded by migration 0004. */
export const SHARED_KEY_RESOURCE_SERVER_ID = '00000000-0000-0000-0000-000000000001';

/** A Resource Server: the principal that owns credentials and settlements. */
export interface ResourceServerTable {
  id: Generated<string>;
  name: string;
  domain: string;
  /** Contact given at registration; not unique, not verified. Never logged. */
  email: string | null;
  status: ColumnType<
    ResourceServerStatus | null,
    ResourceServerStatus | undefined,
    ResourceServerStatus
  >;
  updatedAt: ColumnType<Date, never, Date>;
  createdAt: ColumnType<Date, never, never>;
}

export type ResourceServer = Selectable<ResourceServerTable>;
