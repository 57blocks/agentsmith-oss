import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import type { INestApplication } from '@nestjs/common';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import helmet from 'helmet';
import type { FacilitatorConfig } from './config/facilitator.config.js';
import {
  createStellarPaymentEngine,
  type PaymentEngine,
} from './modules/x402/services/engine/payment-engine.js';
import { logger, type Logger } from './common/logger.js';
import { X402Module } from './modules/x402/x402.module.js';
import { createChannelRuntime, type ChannelRuntime } from './modules/channels/channel-runtime.js';
import { createAwsKmsClient } from './modules/channels/kms/aws-kms-client.js';
import type { KmsSigningClient } from './modules/channels/kms/kms-signer.js';
import { DurablePaymentEngine } from './modules/x402/services/persistence/durable-payment-engine.js';
import {
  createSettlementPersistence,
  type SettlementPersistence,
} from './modules/x402/services/persistence/settlement-persistence.js';
import type { SettlementJournal } from './modules/x402/services/persistence/settlement-journal.js';
import { HttpErrorFilter } from './common/filters/http-error.filter.js';
import { RedisRateLimitStore, type RateLimitStore } from './common/rate-limit/rate-limit-store.js';
import { createChannelStoreClient } from './modules/channels/core/redis-lease-store.js';
import { requestLogger } from './common/middleware/request-logger.middleware.js';
import { SERVICE_VERSION } from './common/version.js';

export interface AppOptions {
  config: FacilitatorConfig;
  /** An injected engine brings its own channels; `channels` is then optional. */
  engine?: PaymentEngine;
  channels?: ChannelRuntime;
  log?: Logger;
  /** Rate-limit counters; the channel store (Valkey) when not given, so instances share them. */
  rateLimits?: RateLimitStore;
  /** Durable settlement records; built from `DATABASE_URL` when not given, as tests do with PGlite. */
  persistence?: SettlementPersistence;
}

/** The engine on the shared channel pool, closing the pool's connection if the engine fails. */
async function engineOnChannels(
  config: FacilitatorConfig,
  log: Logger,
  channels: ChannelRuntime,
  deps: { journal: SettlementJournal; kms?: KmsSigningClient },
): Promise<PaymentEngine> {
  try {
    return await createStellarPaymentEngine(config, log, { pool: channels.pool, ...deps });
  } catch (error) {
    await channels.stop();
    throw error;
  }
}

/**
 * OpenAPI at `/docs-json` and Swagger UI at `/docs`. The server URL is relative, so it resolves
 * against wherever the document was fetched from, including behind a path prefix.
 */
function serveApiDocs(app: INestApplication): void {
  const config = new DocumentBuilder()
    .setTitle('AgentSmith Stellar x402 Facilitator')
    .setDescription(
      'x402 v2 /supported, /verify and /settle on Stellar, plus local API-key routes. ' +
        'The x402 schemas are a convenience; the x402 v2 specification is normative.',
    )
    .setVersion(SERVICE_VERSION)
    .addServer('./')
    .addBearerAuth()
    .build();
  // The UI's assets are relative (`./swagger-ui.css`), so they only resolve from `/docs/`. A
  // relative redirect keeps a path prefix such as the load balancer's `/facilitator`.
  app.use((request: Request, response: Response, next: NextFunction) => {
    if (request.method === 'GET' && request.path === '/docs')
      return response.redirect(301, 'docs/');
    next();
  });
  SwaggerModule.setup('docs', app, SwaggerModule.createDocument(app, config), {
    jsonDocumentUrl: 'docs-json',
  });
}

export async function createApp(options: AppOptions): Promise<INestApplication> {
  const config = options.config;
  const log = options.log || logger;
  const persistence = options.persistence ?? createSettlementPersistence(config, log);
  const rateLimits =
    options.rateLimits ??
    new RedisRateLimitStore(
      createChannelStoreClient(config.channelPool.storeUrl, {
        commandTimeoutMs: config.channelPool.storeCommandTimeoutMs,
        log,
      }),
    );
  let { engine: baseEngine, channels } = options;
  if (!baseEngine) {
    // One KMS client for every role: channels in the pool, fee payer and authorization key here.
    const kms = config.kms ? createAwsKmsClient(config.kms.region) : undefined;
    channels ??= createChannelRuntime(config, log, { kms });
    baseEngine = await engineOnChannels(config, log, channels, {
      journal: persistence.journal,
      kms,
    });
  }
  const engine = new DurablePaymentEngine(baseEngine, persistence);
  const app = await NestFactory.create(
    X402Module.register({ ...options, engine, channels, persistence, rateLimits }),
    {
      bodyParser: false,
      logger: false,
    },
  );
  const expressApp = app.getHttpAdapter().getInstance() as Express;
  expressApp.disable('x-powered-by');
  expressApp.set('trust proxy', config.trustProxy);

  app.use(helmet());
  app.enableCors({ origin: config.corsOrigins });
  app.use(express.json({ limit: config.maxBodySize }));
  app.use(requestLogger(log));

  serveApiDocs(app);
  app.useGlobalFilters(app.get(HttpErrorFilter));
  await app.init();
  return app;
}
