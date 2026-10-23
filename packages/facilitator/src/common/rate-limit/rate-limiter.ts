import { HttpException, Inject, Injectable } from '@nestjs/common';
import type { Response } from 'express';
import type { Logger } from '../logger.js';
import { LOG, RATE_LIMITS } from '../tokens.js';
import { windowOf, type RateLimitStore } from './rate-limit-store.js';

export interface RateLimitPolicy {
  windowMs: number;
  max: number;
  /** The 429 message. */
  message: string;
}

/**
 * Enforces fixed-window limits. When the store cannot be reached, `fallback` may supply the hits
 * counted elsewhere; without one, nothing is limited.
 */
@Injectable()
export class RateLimiter {
  constructor(
    @Inject(RATE_LIMITS) private readonly store: RateLimitStore,
    @Inject(LOG) private readonly log: Logger,
  ) {}

  /**
   * Throws 429 once `key` is over `policy`, and sets the standard rate-limit headers. `fallback`
   * returns the earlier hits in the window, or undefined to let the request through; it is called
   * only when the store fails, and its own error propagates.
   */
  async enforce(
    key: string,
    policy: RateLimitPolicy,
    response: Response,
    fallback?: () => Promise<number | undefined>,
  ): Promise<void> {
    const count = await this.store.hit(key, policy.windowMs).catch(async (error: unknown) => {
      this.log.warn('rate_limit_store_unavailable', {
        errorName: error instanceof Error ? error.name : 'unknown',
      });
      const earlier = await fallback?.();
      return earlier === undefined ? 0 : earlier + 1;
    });
    if (count === 0) return;
    const now = Date.now();
    const resetSeconds = Math.ceil(
      ((windowOf(now, policy.windowMs) + 1) * policy.windowMs - now) / 1000,
    );
    response.setHeader('RateLimit-Limit', String(policy.max));
    response.setHeader('RateLimit-Remaining', String(Math.max(0, policy.max - count)));
    response.setHeader('RateLimit-Reset', String(resetSeconds));
    if (count <= policy.max) return;
    response.setHeader('Retry-After', String(resetSeconds));
    throw new HttpException({ error: { code: 'RATE_LIMITED', message: policy.message } }, 429);
  }
}
