import { CanActivate, ExecutionContext, HttpException, Inject, Injectable } from '@nestjs/common';
import { createHash, timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';
import { CONFIG } from '../../../common/tokens.js';
import type { FacilitatorConfig } from '../../../config/facilitator.config.js';

/** The request after `AdminGuard`: the name of the admin whose key it sent. */
export type AdminRequest = Request & { admin: string };

const UNAUTHORIZED = { error: { code: 'UNAUTHORIZED', message: 'Admin token required' } };

const digest = (value: string) => createHash('sha256').update(value).digest();

/** Admits a request whose Bearer key is one of `ADMIN_API_KEYS`, and names that admin. */
@Injectable()
export class AdminGuard implements CanActivate {
  private readonly admins: ReadonlyArray<{ name: string; digest: Buffer }>;

  constructor(@Inject(CONFIG) config: FacilitatorConfig) {
    this.admins = Object.entries(config.adminApiKeys).map(([name, key]) => ({
      name,
      digest: digest(key),
    }));
  }

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<AdminRequest>();
    const sent = digest(request.get('authorization')?.replace(/^Bearer\s+/i, '') ?? '');
    // Compare with every admin, so the time taken does not reveal which name matched.
    const match = this.admins.filter((admin) => timingSafeEqual(admin.digest, sent))[0];
    if (!match) throw new HttpException(UNAUTHORIZED, 401);
    request.admin = match.name;
    return true;
  }
}
