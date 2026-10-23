import type { ColumnType, Generated } from 'kysely';

/** A successful registration's source, kept only for the registration window. */
export interface RegistrationSourceTable {
  id: Generated<string>;
  /** HMAC-SHA-256 of the source IP under `REGISTRATION_IP_HASH_KEY`; the IP is never stored. */
  ipDigest: Buffer;
  createdAt: ColumnType<Date, never, never>;
}
