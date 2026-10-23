import {
  DynamicModule,
  Inject,
  Injectable,
  Module,
  type OnApplicationShutdown,
} from '@nestjs/common';
import type { AppOptions } from '../../app.js';
import { ChannelsModule } from '../channels/channels.module.js';
import { HttpErrorFilter } from '../../common/filters/http-error.filter.js';
import { DatabaseModule } from '../../common/database/database.module.js';
import { CredentialsModule } from '../credentials/credentials.module.js';
import type { RateLimitStore } from '../../common/rate-limit/rate-limit-store.js';
import { logger } from '../../common/logger.js';
import { CONFIG, ENGINE, LOG, SETTLEMENT_PERSISTENCE, SETTLEMENTS } from '../../common/tokens.js';
import { X402Controller } from './x402.controller.js';
import { BazaarReporter } from './services/bazaar/bazaar-reporter.js';
import { X402Service } from './services/x402.service.js';
import type { PaymentEngine } from './services/engine/payment-engine.js';
import { SettlementCoordinator } from './services/engine/settlement-coordinator.js';
import type { SettlementPersistence } from './services/persistence/settlement-persistence.js';

@Injectable()
class PersistenceLifecycle implements OnApplicationShutdown {
  constructor(
    @Inject(SETTLEMENT_PERSISTENCE) private readonly persistence: SettlementPersistence,
  ) {}

  async onApplicationShutdown(): Promise<void> {
    await this.persistence.close();
  }
}

@Module({})
export class X402Module {
  static register(
    options: AppOptions & {
      engine: PaymentEngine;
      persistence: SettlementPersistence;
      rateLimits: RateLimitStore;
    },
  ): DynamicModule {
    const log = options.log || logger;
    return {
      module: X402Module,
      imports: [
        DatabaseModule.register(options.persistence.db),
        CredentialsModule.register({
          config: options.config,
          rateLimits: options.rateLimits,
          log,
        }),
        ...(options.channels ? [ChannelsModule.register(options.channels)] : []),
      ],
      controllers: [X402Controller],
      providers: [
        { provide: CONFIG, useValue: options.config },
        { provide: ENGINE, useValue: options.engine },
        { provide: SETTLEMENT_PERSISTENCE, useValue: options.persistence },
        PersistenceLifecycle,
        { provide: LOG, useValue: log },
        {
          provide: SETTLEMENTS,
          useValue: new SettlementCoordinator(
            options.config.settlementCacheTtlMs,
            options.config.settlementCacheMaxEntries,
          ),
        },
        X402Service,
        BazaarReporter,
        HttpErrorFilter,
      ],
    };
  }
}
