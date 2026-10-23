import { CanActivate, ExecutionContext, HttpException, Inject, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { Request, Response } from 'express';
import { RateLimiter, type RateLimitPolicy } from '../../../common/rate-limit/rate-limiter.js';
import { CONFIG } from '../../../common/tokens.js';
import type { FacilitatorConfig } from '../../../config/facilitator.config.js';
import { SHARED_KEY_RESOURCE_SERVER_ID } from '../../../models/credentials/resource-server.model.js';
import type { AttributedRequest } from '../caller.js';
import {
  ApiCredentialRepository,
  type ActiveCredential,
} from '../repositories/api-credential.repository.js';

const UNAUTHORIZED = { error: { code: 'UNAUTHORIZED', message: 'Bearer token required' } };
const STORE_UNAVAILABLE = {
  error: { code: 'CREDENTIAL_STORE_UNAVAILABLE', message: 'Credentials cannot be checked' },
};

function bearerKey(request: Request): string | undefined {
  return request.get('authorization')?.replace(/^Bearer\s+/i, '') || undefined;
}

/**
 * Attributes an x402 request to the Resource Server whose key it sends, then rate-limits it:
 * per server with a valid key, per IP otherwise, so failed authentication is counted too. Pubnet
 * requires a key; testnet serves a request without one as the shared placeholder server, but
 * checks a key that is sent. Unknown, expired and revoked keys get the same 401; an unreadable
 * credential store, 503.
 */
@Injectable()
export class CallerGuard implements CanActivate {
  private readonly policy: RateLimitPolicy;

  constructor(
    @Inject(CONFIG) private readonly config: FacilitatorConfig,
    @Inject(ApiCredentialRepository) private readonly credentials: ApiCredentialRepository,
    @Inject(RateLimiter) private readonly limiter: RateLimiter,
  ) {
    this.policy = {
      windowMs: config.rateLimitWindowMs,
      max: config.rateLimitMax,
      message: 'Too many requests',
    };
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const http = context.switchToHttp();
    const request = http.getRequest<AttributedRequest>();
    const key = bearerKey(request);
    const credential = key ? await this.lookUp(key) : undefined;
    const counted = credential ? `rs:${credential.resourceServerId}` : `ip:${request.ip}`;
    await this.limiter.enforce(counted, this.policy, http.getResponse<Response>());
    if (credential) {
      request.caller = credential;
      return true;
    }
    if (key || this.config.network === 'stellar:pubnet') throw new HttpException(UNAUTHORIZED, 401);
    request.caller = { resourceServerId: SHARED_KEY_RESOURCE_SERVER_ID };
    return true;
  }

  private async lookUp(key: string): Promise<ActiveCredential | undefined> {
    const digest = createHash('sha256').update(key).digest();
    return this.credentials.findActiveBySecretDigest(digest).catch(() => {
      throw new HttpException(STORE_UNAVAILABLE, 503);
    });
  }
}
