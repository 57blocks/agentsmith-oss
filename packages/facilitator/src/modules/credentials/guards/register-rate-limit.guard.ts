import { CanActivate, ExecutionContext, Inject, Injectable } from '@nestjs/common';
import type { Request, Response } from 'express';
import { RateLimiter, type RateLimitPolicy } from '../../../common/rate-limit/rate-limiter.js';
import { CONFIG } from '../../../common/tokens.js';
import type { FacilitatorConfig } from '../../../config/facilitator.config.js';
import { CredentialsService } from '../services/credentials.service.js';

/**
 * Limits registrations per IP: registration needs no key, so the IP is all there is to count.
 * While the channel store is down, the successful registrations recorded in the database count.
 */
@Injectable()
export class RegisterRateLimitGuard implements CanActivate {
  private readonly policy: RateLimitPolicy;

  constructor(
    @Inject(CONFIG) config: FacilitatorConfig,
    @Inject(RateLimiter) private readonly limiter: RateLimiter,
    @Inject(CredentialsService) private readonly credentials: CredentialsService,
  ) {
    this.policy = {
      windowMs: config.registerRateLimitWindowMs,
      max: config.registerRateLimitMax,
      message: 'Too many registrations',
    };
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const http = context.switchToHttp();
    const ip = http.getRequest<Request>().ip;
    await this.limiter.enforce(`register:${ip}`, this.policy, http.getResponse<Response>(), () =>
      this.credentials.registrationsFrom(ip),
    );
    return true;
  }
}
