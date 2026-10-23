import type { ColumnType, Generated, Selectable } from 'kysely';

/** One API key of a Resource Server. Only a digest is stored; the plaintext is shown once. */
export interface ApiCredentialTable {
  id: Generated<string>;
  resourceServerId: string;
  /** SHA-256 of the plaintext API key. */
  secretDigest: Uint8Array;
  expiresAt: Date | null;
  revokedAt: Date | null;
  createdAt: ColumnType<Date, never, never>;
}

export type ApiCredential = Selectable<ApiCredentialTable>;
