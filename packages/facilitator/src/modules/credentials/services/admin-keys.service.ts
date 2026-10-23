import { Inject, Injectable } from '@nestjs/common';
import type { Kysely } from 'kysely';
import { DATABASE } from '../../../common/tokens.js';
import type { Database } from '../../../models/database.js';
import { AdminAuditRepository } from '../repositories/admin-audit.repository.js';
import { ApiCredentialRepository } from '../repositories/api-credential.repository.js';
import { ResourceServerRepository } from '../repositories/resource-server.repository.js';
import { issueReplacingCurrent } from './credentials.service.js';

/** No Resource Server, or no unrevoked key, has this id. */
export class NotFoundError extends Error {}

/** The Resource Server is not active, so a key issued for it could never authenticate. */
export class ServerDisabledError extends Error {}

/** Admin actions on any Resource Server's keys; each commits together with its audit row. */
@Injectable()
export class AdminKeysService {
  constructor(@Inject(DATABASE) private readonly db: Kysely<Database>) {}

  /** A new current key for the server, e.g. one that lost its own; its old key gets the grace. */
  issue(
    admin: string,
    resourceServerId: string,
  ): Promise<{ credentialId: string; apiKey: string }> {
    return this.db.transaction().execute(async (trx) => {
      const server = await new ResourceServerRepository(trx).lock(resourceServerId);
      if (!server) throw new NotFoundError();
      // Authentication accepts keys of active servers only.
      if (server.status !== 'active') throw new ServerDisabledError();
      const credentials = new ApiCredentialRepository(trx);
      const current = await credentials.findCurrent(resourceServerId);
      const issued = await issueReplacingCurrent(credentials, resourceServerId, current);
      await new AdminAuditRepository(trx).record({
        actor: admin,
        action: 'issue_key',
        resourceServerId,
        credentialId: issued.credentialId,
      });
      return issued;
    });
  }

  /** Revokes any key at once. */
  revoke(admin: string, credentialId: string): Promise<void> {
    return this.db.transaction().execute(async (trx) => {
      const resourceServerId = await new ApiCredentialRepository(trx).revokeReturningServer(
        credentialId,
      );
      if (!resourceServerId) throw new NotFoundError();
      await new AdminAuditRepository(trx).record({
        actor: admin,
        action: 'revoke_key',
        resourceServerId,
        credentialId,
      });
    });
  }
}
