import {
  Inject,
  Injectable,
  Module,
  type DynamicModule,
  type OnApplicationShutdown,
} from '@nestjs/common';
import type { Logger } from '../../common/logger.js';
import type { RateLimitStore } from '../../common/rate-limit/rate-limit-store.js';
import { RateLimiter } from '../../common/rate-limit/rate-limiter.js';
import { CONFIG, LOG, RATE_LIMITS } from '../../common/tokens.js';
import type { FacilitatorConfig } from '../../config/facilitator.config.js';
import { AdminController } from './admin.controller.js';
import { CredentialsController } from './credentials.controller.js';
import { AdminGuard } from './guards/admin.guard.js';
import { CallerGuard } from './guards/caller.guard.js';
import { RegisterRateLimitGuard } from './guards/register-rate-limit.guard.js';
import { ApiCredentialRepository } from './repositories/api-credential.repository.js';
import { AdminKeysService } from './services/admin-keys.service.js';
import { CredentialsService } from './services/credentials.service.js';

@Injectable()
class RateLimitStoreShutdown implements OnApplicationShutdown {
  constructor(@Inject(RATE_LIMITS) private readonly store: RateLimitStore) {}

  async onApplicationShutdown(): Promise<void> {
    await this.store.close?.();
  }
}

export interface CredentialsModuleOptions {
  config: FacilitatorConfig;
  rateLimits: RateLimitStore;
  log: Logger;
}

/** Resource Server registration, key self-service, and the guard that attributes x402 calls. */
@Module({})
export class CredentialsModule {
  static register({ config, rateLimits, log }: CredentialsModuleOptions): DynamicModule {
    return {
      module: CredentialsModule,
      controllers: [CredentialsController, AdminController],
      providers: [
        { provide: CONFIG, useValue: config },
        { provide: RATE_LIMITS, useValue: rateLimits },
        { provide: LOG, useValue: log },
        RateLimitStoreShutdown,
        RateLimiter,
        ApiCredentialRepository,
        CredentialsService,
        CallerGuard,
        RegisterRateLimitGuard,
        AdminKeysService,
        AdminGuard,
      ],
      exports: [ApiCredentialRepository, CallerGuard, RateLimiter],
    };
  }
}
