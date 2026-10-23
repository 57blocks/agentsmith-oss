import { Inject, Injectable } from '@nestjs/common';
import { sql, type Kysely } from 'kysely';
import { DATABASE } from '../../../common/tokens.js';
import type { ApiCredential } from '../../../models/credentials/api-credential.model.js';
import type { Database } from '../../../models/database.js';

export interface NewApiCredential {
  resourceServerId: string;
  secretDigest: Uint8Array;
  expiresAt?: Date | null;
}

/** What request authentication needs to attribute the call. */
export interface ActiveCredential {
  credentialId: string;
  resourceServerId: string;
}

@Injectable()
export class ApiCredentialRepository {
  constructor(@Inject(DATABASE) private readonly db: Kysely<Database>) {}

  issue(credential: NewApiCredential): Promise<ApiCredential> {
    return this.db
      .insertInto('apiCredentials')
      .values(credential)
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  /**
   * The credential for this key digest, only if it is not revoked, has not expired, and its
   * Resource Server is active.
   */
  findActiveBySecretDigest(secretDigest: Uint8Array): Promise<ActiveCredential | undefined> {
    return this.db
      .selectFrom('apiCredentials as credential')
      .innerJoin('resourceServer as server', 'server.id', 'credential.resourceServerId')
      .select(['credential.id as credentialId', 'credential.resourceServerId'])
      .where('credential.secretDigest', '=', secretDigest)
      .where('credential.revokedAt', 'is', null)
      .where((eb) =>
        eb.or([
          eb('credential.expiresAt', 'is', null),
          eb('credential.expiresAt', '>', sql<Date>`now()`),
        ]),
      )
      .where('server.status', '=', 'active')
      .executeTakeFirst();
  }

  listByResourceServer(resourceServerId: string): Promise<ApiCredential[]> {
    return this.db
      .selectFrom('apiCredentials')
      .selectAll()
      .where('resourceServerId', '=', resourceServerId)
      .orderBy('createdAt')
      .execute();
  }

  /**
   * The server's newest key, if it is neither revoked nor expired: the only one that rotates. A key
   * that was replaced never becomes current again, even when its replacement is revoked.
   */
  findCurrent(resourceServerId: string): Promise<ApiCredential | undefined> {
    const newest = this.db
      .selectFrom('apiCredentials')
      .selectAll()
      .where('resourceServerId', '=', resourceServerId)
      .orderBy('createdAt', 'desc')
      .limit(1)
      .as('newest');
    return this.db
      .selectFrom(newest)
      .selectAll()
      .where('revokedAt', 'is', null)
      .where((eb) => eb.or([eb('expiresAt', 'is', null), eb('expiresAt', '>', sql<Date>`now()`)]))
      .executeTakeFirst();
  }

  /**
   * Makes the key expire `inMs` from now, unless it already expires sooner. Measured on the database
   * clock, which the authentication lookup also uses.
   */
  async expireWithin(id: string, inMs: number): Promise<boolean> {
    const deadline = sql<Date>`now() + ${inMs} * interval '1 millisecond'`;
    const result = await this.db
      .updateTable('apiCredentials')
      .set({ expiresAt: sql<Date>`least(coalesce(expires_at, ${deadline}), ${deadline})` })
      .where('id', '=', id)
      .where('revokedAt', 'is', null)
      .executeTakeFirst();
    return result.numUpdatedRows > 0n;
  }

  /** Revokes the key and returns its server; undefined when it is unknown or already revoked. */
  async revokeReturningServer(id: string): Promise<string | undefined> {
    const row = await this.db
      .updateTable('apiCredentials')
      .set({ revokedAt: sql<Date>`now()` })
      .where('id', '=', id)
      .where('revokedAt', 'is', null)
      .returning('resourceServerId')
      .executeTakeFirst();
    return row?.resourceServerId;
  }

  /** Returns false when the credential does not exist or is already revoked; a revocation is final. */
  async revoke(id: string): Promise<boolean> {
    const result = await this.db
      .updateTable('apiCredentials')
      .set({ revokedAt: sql<Date>`now()` })
      .where('id', '=', id)
      .where('revokedAt', 'is', null)
      .executeTakeFirst();
    return result.numUpdatedRows > 0n;
  }
}
