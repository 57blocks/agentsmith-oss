import { Inject, Injectable } from '@nestjs/common';
import type { Kysely } from 'kysely';
import { CONFIG, DATABASE } from '../../../common/tokens.js';
import type { FacilitatorConfig } from '../../../config/facilitator.config.js';
import type { ApiCredential } from '../../../models/credentials/api-credential.model.js';
import type { Database } from '../../../models/database.js';
import type { RegisterRequestDto } from '../dto/credentials-request.dto.js';
import { ApiCredentialRepository } from '../repositories/api-credential.repository.js';
import { RegistrationSourceRepository } from '../repositories/registration-source.repository.js';
import { ResourceServerRepository } from '../repositories/resource-server.repository.js';
import { apiKeyDigest, newApiKey, registrationSourceDigest } from './secrets.js';

/** The domain is already registered to another Resource Server. */
export class DomainTakenError extends Error {}

/** The presented key is not its server's current key, e.g. it is being replaced. */
export class NotCurrentKeyError extends Error {}

/** How long a rotated-out key keeps working, so the server can switch without a gap. */
export const ROTATION_GRACE_MS = 10 * 60_000;

/** A caller that proved itself with a key. */
export interface KeyHolder {
  resourceServerId: string;
  credentialId: string;
}

/** PostgreSQL's unique_violation, as `pg` and PGlite both report it. */
function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === '23505';
}

/**
 * Issues a new current key for a server whose row the caller has locked, and gives the previous
 * current key, if any, `ROTATION_GRACE_MS` more. The plaintext key is returned only here.
 */
export async function issueReplacingCurrent(
  credentials: ApiCredentialRepository,
  resourceServerId: string,
  current: ApiCredential | undefined,
): Promise<{ credentialId: string; apiKey: string }> {
  const apiKey = newApiKey();
  const issued = await credentials.issue({ resourceServerId, secretDigest: apiKeyDigest(apiKey) });
  if (current) await credentials.expireWithin(current.id, ROTATION_GRACE_MS);
  return { credentialId: issued.id, apiKey };
}

/** Resource Server self-service: registration and the server's own key. */
@Injectable()
export class CredentialsService {
  constructor(
    @Inject(DATABASE) private readonly db: Kysely<Database>,
    @Inject(CONFIG) private readonly config: FacilitatorConfig,
  ) {}

  /**
   * Creates the server and its first key together, and records the source IP's digest with them;
   * the plaintext key is returned only here.
   */
  async register(
    request: RegisterRequestDto,
    sourceIp: string | undefined,
  ): Promise<{ resourceServerId: string; apiKey: string }> {
    const apiKey = newApiKey();
    const source = this.sourceDigest(sourceIp);
    try {
      return await this.db.transaction().execute(async (trx) => {
        const server = await new ResourceServerRepository(trx).create(request);
        await new ApiCredentialRepository(trx).issue({
          resourceServerId: server.id,
          secretDigest: apiKeyDigest(apiKey),
        });
        if (source) {
          await new RegistrationSourceRepository(trx).record(
            source,
            this.config.registerRateLimitWindowMs,
          );
        }
        return { resourceServerId: server.id, apiKey };
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw new DomainTakenError();
      throw error;
    }
  }

  /**
   * Successful registrations from this IP in the registration window, or undefined when sources
   * are not recorded (no `REGISTRATION_IP_HASH_KEY`, or no IP).
   */
  async registrationsFrom(sourceIp: string | undefined): Promise<number | undefined> {
    const source = this.sourceDigest(sourceIp);
    if (!source) return undefined;
    return new RegistrationSourceRepository(this.db).countWithin(
      source,
      this.config.registerRateLimitWindowMs,
    );
  }

  private sourceDigest(sourceIp: string | undefined): Buffer | undefined {
    const key = this.config.registrationIpHashKey;
    return key && sourceIp ? registrationSourceDigest(sourceIp, key) : undefined;
  }

  /**
   * Issues a new current key and gives the presented one `ROTATION_GRACE_MS` more. The server's row
   * is locked, so two rotations cannot both leave a current key.
   */
  rotate(holder: KeyHolder): Promise<{ apiKey: string }> {
    return this.db.transaction().execute(async (trx) => {
      await new ResourceServerRepository(trx).lock(holder.resourceServerId);
      const credentials = new ApiCredentialRepository(trx);
      const current = await credentials.findCurrent(holder.resourceServerId);
      if (current?.id !== holder.credentialId) throw new NotCurrentKeyError();
      const { apiKey } = await issueReplacingCurrent(credentials, holder.resourceServerId, current);
      return { apiKey };
    });
  }

  /** Revokes the presented key at once. */
  async revokeCurrent(holder: KeyHolder): Promise<void> {
    await new ApiCredentialRepository(this.db).revoke(holder.credentialId);
  }
}
