import { afterEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import type { SettleResponse, SupportedResponse, VerifyResponse } from '@x402/core/types';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Keypair } from '@stellar/stellar-sdk';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config/facilitator.config.js';
import { fakeKms } from './fake-kms.js';
import { fakeChannelPool, FakeClock, FakeLeaseStore } from './fake-lease-store.js';
import { createChannelRuntime } from '../src/modules/channels/channel-runtime.js';
import type { FacilitatorConfig } from '../src/config/facilitator.config.js';
import {
  createStellarPaymentEngine,
  type PaymentEngine,
} from '../src/modules/x402/services/engine/payment-engine.js';
import type { Logger } from '../src/common/logger.js';
import { TEST_DATABASE_URL } from './test-env.js';
import { exactPaymentXdr, uptoPaymentXdr } from './settlement-fixtures.js';
import { createTestDatabase } from './test-database.js';
import { createSettlementPersistence } from '../src/modules/x402/services/persistence/settlement-persistence.js';
import { MemoryRateLimitStore } from '../src/common/rate-limit/rate-limit-store.js';
import { journalWithoutDatabase } from './test-journal.js';

const requirements = {
  scheme: 'exact',
  network: 'stellar:testnet',
  amount: '10000',
  asset: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM',
  payTo: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
  maxTimeoutSeconds: 60,
  extra: { areFeesSponsored: true },
};

const body = {
  x402Version: 2,
  paymentPayload: {
    x402Version: 2,
    accepted: requirements,
    payload: { transaction: exactPaymentXdr() },
  },
  paymentRequirements: requirements,
};

function config(overrides: Partial<FacilitatorConfig> = {}): FacilitatorConfig {
  return {
    port: 8407,
    host: '127.0.0.1',
    nodeEnv: 'test',
    network: 'stellar:testnet',
    rpcUrl: 'https://soroban-testnet.stellar.org',
    signingMode: 'env',
    feeBumpSecret: 'S_TEST_ONLY',
    channelSecrets: ['S_CHANNEL_TEST_ONLY'],
    databaseUrl: TEST_DATABASE_URL,
    adminApiKeys: {},
    registerRateLimitWindowMs: 3_600_000,
    registerRateLimitMax: 5,
    maxResourceFeeStroops: 50_000,
    maxBodySize: '256kb',
    rateLimitWindowMs: 60_000,
    rateLimitMax: 10_000,
    settlementCacheTtlMs: 300_000,
    settlementCacheMaxEntries: 100,
    trustProxy: ['loopback'],
    corsOrigins: '*',
    shutdownTimeoutMs: 10_000,
    ...overrides,
  };
}

function engine(overrides: Partial<PaymentEngine> = {}): PaymentEngine {
  return {
    verify: vi.fn(async () => ({ isValid: true, payer: requirements.payTo }) as VerifyResponse),
    settle: vi.fn(
      async () =>
        ({
          success: true,
          payer: requirements.payTo,
          transaction: 'abc123',
          network: 'stellar:testnet',
        }) as SettleResponse,
    ),
    supported: vi.fn(
      () =>
        ({
          kinds: [
            {
              x402Version: 2,
              scheme: 'exact',
              network: 'stellar:testnet',
              extra: { areFeesSponsored: true },
            },
          ],
          extensions: [],
          signers: { 'stellar:*': ['GFACILITATOR'] },
        }) as SupportedResponse,
    ),
    ...overrides,
  };
}

const silentLogger: Logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

const openApps: INestApplication[] = [];

/** An app on its own in-process database, unless the test brings its persistence. */
async function createTestApp(options: Parameters<typeof createApp>[0]): Promise<INestApplication> {
  const persistence =
    options.persistence ??
    createSettlementPersistence(options.config, silentLogger, { db: await createTestDatabase() });
  const app = await createApp({
    rateLimits: new MemoryRateLimitStore(),
    ...options,
    persistence,
  });
  await app.listen(0, '127.0.0.1');
  openApps.push(app);
  return app;
}

afterEach(async () => {
  await Promise.all(openApps.splice(0).map((app) => app.close()));
});

const packageVersion: string = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
).version;

// Each app gets a fresh, migrated PGlite database; the first one also loads the WASM build.
vi.setConfig({ testTimeout: 15_000 });

describe('Stellar facilitator HTTP interface', () => {
  it('publishes health without any secret material', async () => {
    const app = await createTestApp({ config: config(), engine: engine(), log: silentLogger });
    const response = await request(app.getHttpServer()).get('/health');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      ok: true,
      service: 'agentsmith-stellar-facilitator',
      version: packageVersion,
      network: 'stellar:testnet',
    });
    expect(JSON.stringify(response.body)).not.toContain('S_TEST_ONLY');
  });

  it('does not report the signing mode on health, even with kms keys', async () => {
    const randomKeypair = () => Keypair.fromRawEd25519Seed(randomBytes(32));
    const [feePayer, channel] = [randomKeypair(), randomKeypair()];
    const kmsConfig = loadConfig({
      DATABASE_URL: TEST_DATABASE_URL,
      CHANNEL_STORE_URL: 'redis://127.0.0.1:6379',
      FACILITATOR_SIGNING_MODE: 'kms',
      FACILITATOR_KMS_REGION: 'us-west-1',
      FACILITATOR_KMS_FEE_PAYER_ADDRESS: feePayer.publicKey(),
      FACILITATOR_KMS_CHANNEL_ADDRESSES: channel.publicKey(),
    });
    const kmsEngine = await createStellarPaymentEngine(kmsConfig, silentLogger, {
      kms: fakeKms([feePayer, channel]).client,
      pool: fakeChannelPool([]).pool,
      journal: journalWithoutDatabase(),
    });
    const app = await createTestApp({ config: kmsConfig, engine: kmsEngine, log: silentLogger });
    const response = await request(app.getHttpServer()).get('/health');
    expect(response.body).not.toHaveProperty('signing');
  });

  it('builds the engine on the channel runtime and seeds the store once started', async () => {
    const randomKeypair = () => Keypair.fromRawEd25519Seed(randomBytes(32));
    const [feePayer, channel] = [randomKeypair(), randomKeypair()];
    const envConfig = loadConfig({
      DATABASE_URL: TEST_DATABASE_URL,
      CHANNEL_STORE_URL: 'redis://127.0.0.1:6379',
      FACILITATOR_STELLAR_FEE_BUMP_SECRET: feePayer.secret(),
      FACILITATOR_STELLAR_CHANNEL_SECRETS: channel.secret(),
    });
    const store = new FakeLeaseStore(new FakeClock());
    const channels = createChannelRuntime(envConfig, silentLogger, { store });
    const app = await createTestApp({ config: envConfig, channels, log: silentLogger });

    const response = await request(app.getHttpServer()).get('/supported');
    expect(response.body.signers).toEqual({ 'stellar:*': [] });
    await vi.waitFor(async () => expect(await store.members()).toEqual([channel.publicKey()]));
  });

  it('returns the standard sponsored Stellar kind from /supported', async () => {
    const app = await createTestApp({ config: config(), engine: engine(), log: silentLogger });
    const response = await request(app.getHttpServer()).get('/supported');
    expect(response.status).toBe(200);
    expect(response.body.kinds[0]).toEqual({
      x402Version: 2,
      scheme: 'exact',
      network: 'stellar:testnet',
      extra: { areFeesSponsored: true },
    });
    expect(response.body.signers).toEqual({ 'stellar:*': ['GFACILITATOR'] });
  });

  it('forwards a valid v2 verification request to the engine', async () => {
    const paymentEngine = engine();
    const app = await createTestApp({ config: config(), engine: paymentEngine, log: silentLogger });
    const response = await request(app.getHttpServer()).post('/verify').send(body);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ isValid: true, payer: requirements.payTo });
    expect(paymentEngine.verify).toHaveBeenCalledExactlyOnceWith(body.paymentPayload, requirements);
  });

  it('rejects malformed and non-v2 requests before they reach the engine', async () => {
    const paymentEngine = engine();
    const app = await createTestApp({ config: config(), engine: paymentEngine, log: silentLogger });
    const response = await request(app.getHttpServer())
      .post('/verify')
      .send({ ...body, x402Version: 1 });
    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ isValid: false, invalidReason: 'invalid_x402_version' });
    expect(paymentEngine.verify).not.toHaveBeenCalled();
  });

  it('keeps the x402 settle shape and reason when the settle body is malformed', async () => {
    const paymentEngine = engine();
    const app = await createTestApp({ config: config(), engine: paymentEngine, log: silentLogger });
    const response = await request(app.getHttpServer())
      .post('/settle')
      .send({ ...body, paymentRequirements: { ...requirements, amount: '1.5' } });
    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      success: false,
      errorReason: 'invalid_payment_requirements',
      transaction: '',
      network: 'stellar:testnet',
    });
    expect(response.body.errorMessage).toContain('paymentRequirements.amount');
    expect(paymentEngine.settle).not.toHaveBeenCalled();
  });

  it('rejects malformed nested payment data on both routes before invoking the engine', async () => {
    const paymentEngine = engine();
    const app = await createTestApp({ config: config(), engine: paymentEngine, log: silentLogger });
    const malformed = {
      ...body,
      paymentPayload: { ...body.paymentPayload, accepted: null },
    };

    const verification = await request(app.getHttpServer()).post('/verify').send(malformed);
    const settlement = await request(app.getHttpServer()).post('/settle').send(malformed);

    expect(verification.status).toBe(400);
    expect(verification.body).toMatchObject({ isValid: false, invalidReason: 'invalid_payload' });
    expect(settlement.status).toBe(400);
    expect(settlement.body).toMatchObject({
      success: false,
      errorReason: 'invalid_payload',
      transaction: '',
      network: 'stellar:testnet',
    });
    expect(verification.body.invalidMessage).toContain('paymentPayload.accepted');
    expect(settlement.body.errorMessage).toContain('paymentPayload.accepted');
    expect(paymentEngine.verify).not.toHaveBeenCalled();
    expect(paymentEngine.settle).not.toHaveBeenCalled();
  });

  it('retains resource and extension metadata when forwarding a validated DTO', async () => {
    const paymentEngine = engine();
    const app = await createTestApp({ config: config(), engine: paymentEngine, log: silentLogger });
    const payload = {
      ...body.paymentPayload,
      resource: { url: 'https://example.com/weather', description: 'Weather data' },
      extensions: { bazaar: { info: { input: { method: 'POST' } } } },
      futurePayloadField: 'preserved',
    };

    const response = await request(app.getHttpServer())
      .post('/verify')
      .send({ ...body, paymentPayload: payload });

    expect(response.status).toBe(200);
    expect(paymentEngine.verify).toHaveBeenCalledWith(payload, requirements);
  });

  it('reports a network this deployment does not serve as invalid_network', async () => {
    const paymentEngine = engine();
    const app = await createTestApp({ config: config(), engine: paymentEngine, log: silentLogger });
    const pubnet = { ...requirements, network: 'stellar:pubnet' };
    const response = await request(app.getHttpServer())
      .post('/verify')
      .send({
        ...body,
        paymentPayload: { ...body.paymentPayload, accepted: pubnet },
        paymentRequirements: pubnet,
      });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ isValid: false, invalidReason: 'invalid_network' });
    expect(paymentEngine.verify).not.toHaveBeenCalled();
  });

  it('reports a scheme this deployment does not advertise to /verify as unsupported_scheme', async () => {
    const paymentEngine = engine();
    const app = await createTestApp({ config: config(), engine: paymentEngine, log: silentLogger });
    const upto = { ...requirements, scheme: 'upto' };
    const response = await request(app.getHttpServer())
      .post('/verify')
      .send({
        ...body,
        paymentPayload: { ...body.paymentPayload, accepted: upto },
        paymentRequirements: upto,
      });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ isValid: false, invalidReason: 'unsupported_scheme' });
    expect(paymentEngine.verify).not.toHaveBeenCalled();
  });

  it('reports a scheme this deployment does not advertise as unsupported_scheme', async () => {
    const paymentEngine = engine();
    const app = await createTestApp({ config: config(), engine: paymentEngine, log: silentLogger });
    const upto = { ...requirements, scheme: 'upto' };
    const response = await request(app.getHttpServer())
      .post('/settle')
      .send({
        ...body,
        paymentPayload: { ...body.paymentPayload, accepted: upto },
        paymentRequirements: upto,
      });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      success: false,
      errorReason: 'unsupported_scheme',
      transaction: '',
      network: 'stellar:testnet',
    });
    expect(paymentEngine.settle).not.toHaveBeenCalled();
  });

  it('returns protocol-shaped failures without exposing engine details', async () => {
    const paymentEngine = engine({
      verify: vi.fn(async () => {
        throw new Error('RPC https://secret.internal account S_NOT_A_KEY');
      }),
      settle: vi.fn(async () => {
        throw new Error('sequence account details');
      }),
    });
    const app = await createTestApp({ config: config(), engine: paymentEngine, log: silentLogger });
    const verification = await request(app.getHttpServer()).post('/verify').send(body);
    const settlement = await request(app.getHttpServer()).post('/settle').send(body);
    expect(verification.status).toBe(500);
    expect(verification.body).toEqual({ isValid: false, invalidReason: 'unexpected_verify_error' });
    expect(settlement.status).toBe(500);
    expect(settlement.body).toMatchObject({
      success: false,
      errorReason: 'unexpected_settle_error',
      transaction: '',
      network: 'stellar:testnet',
    });
    expect(JSON.stringify([verification.body, settlement.body])).not.toContain('secret.internal');
  });

  it('coalesces concurrent settles and caches successful retries', async () => {
    let release!: (value: SettleResponse) => void;
    const pending = new Promise<SettleResponse>((resolve) => {
      release = resolve;
    });
    const settle = vi.fn(() => pending);
    const app = await createTestApp({
      config: config(),
      engine: engine({ settle }),
      log: silentLogger,
    });

    const first = request(app.getHttpServer()).post('/settle').send(body);
    const second = request(app.getHttpServer()).post('/settle').send(body);
    await new Promise((resolve) => setImmediate(resolve));
    release({ success: true, transaction: 'same-tx', network: 'stellar:testnet' });
    expect((await first).body.transaction).toBe('same-tx');
    expect((await second).body.transaction).toBe('same-tx');
    expect(settle).toHaveBeenCalledOnce();

    const retry = await request(app.getHttpServer()).post('/settle').send(body);
    expect(retry.body.transaction).toBe('same-tx');
    expect(settle).toHaveBeenCalledOnce();
  });

  it('settles zero upto usage for nothing and refuses to charge that authorization later', async () => {
    const uptoMaximum = {
      ...requirements,
      scheme: 'upto',
      amount: '10000',
      extra: {
        areFeesSponsored: true,
        settlementContract: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM',
        facilitator: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
      },
    };
    const paymentPayload = {
      x402Version: 2,
      accepted: uptoMaximum,
      payload: {
        transaction: uptoPaymentXdr(
          uptoMaximum.extra.settlementContract,
          uptoMaximum.extra.facilitator,
        ),
      },
    };
    // What the upto scheme answers once it has verified a zero settlement: nothing was sent.
    const settle = vi.fn(
      async () =>
        ({
          success: true,
          transaction: '',
          network: 'stellar:testnet',
          amount: '0',
          payer: requirements.payTo,
        }) as SettleResponse,
    );
    const supported = vi.fn(
      () =>
        ({
          kinds: [{ x402Version: 2, scheme: 'upto', network: 'stellar:testnet' }],
          extensions: [],
          signers: {},
        }) as SupportedResponse,
    );
    const app = await createTestApp({
      config: config(),
      engine: engine({ settle, supported }),
      log: silentLogger,
    });
    const settleAt = (amount: string) =>
      request(app.getHttpServer())
        .post('/settle')
        .send({ x402Version: 2, paymentPayload, paymentRequirements: { ...uptoMaximum, amount } });

    const zero = await settleAt('0');

    expect(zero.status).toBe(200);
    expect(zero.body).toEqual({
      success: true,
      transaction: '',
      network: 'stellar:testnet',
      amount: '0',
      payer: requirements.payTo,
    });

    const laterCharge = await settleAt('5000');

    expect(laterCharge.body).toEqual({
      success: false,
      errorReason: 'settlement_amount_conflict',
      transaction: '',
      network: 'stellar:testnet',
    });
    expect(settle).toHaveBeenCalledOnce();
  });

  it('reports a successful settlement to Bazaar when configured', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 201 }));
    vi.stubGlobal('fetch', fetchMock);
    const app = await createTestApp({
      config: config({
        bazaarSettlementUrl: 'http://127.0.0.1:8402/discovery/settlements',
        bazaarSettlementApiKey: 'bazaar-secret',
      }),
      engine: engine(),
      log: silentLogger,
    });
    const requestBody = structuredClone(body);
    requestBody.paymentPayload.resource = { url: 'https://agentsmith.xyz/metar/v1/metar' };

    const response = await request(app.getHttpServer()).post('/settle').send(requestBody);

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:8402/discovery/settlements');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer bazaar-secret');
    expect(JSON.parse(String(init.body))).toMatchObject({
      transaction: 'abc123',
      resource_url: 'https://agentsmith.xyz/metar/v1/metar',
      network: 'stellar:testnet',
    });
    vi.unstubAllGlobals();
  });

  it('answers a settlement unchanged when Bazaar cannot be reached', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed');
      }),
    );
    const paymentEngine = engine();
    const app = await createTestApp({
      config: config({ bazaarSettlementUrl: 'http://127.0.0.1:8402/discovery/settlements' }),
      engine: paymentEngine,
      log: silentLogger,
    });
    const requestBody = structuredClone(body);
    requestBody.paymentPayload.resource = { url: 'https://agentsmith.xyz/metar/v1/metar' };

    const response = await request(app.getHttpServer()).post('/settle').send(requestBody);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      success: true,
      payer: requirements.payTo,
      transaction: 'abc123',
      network: 'stellar:testnet',
    });
    expect(paymentEngine.settle).toHaveBeenCalledOnce();
    vi.unstubAllGlobals();
  });

  it('defaults missing extra objects before calling the Stellar scheme', async () => {
    const paymentEngine = engine();
    const withoutExtra = structuredClone(body) as typeof body;
    delete (withoutExtra.paymentPayload.accepted as Partial<typeof requirements>).extra;
    delete (withoutExtra.paymentRequirements as Partial<typeof requirements>).extra;

    const app = await createTestApp({ config: config(), engine: paymentEngine, log: silentLogger });
    const response = await request(app.getHttpServer()).post('/verify').send(withoutExtra);

    expect(response.status).toBe(200);
    expect(paymentEngine.verify).toHaveBeenCalledWith(
      expect.objectContaining({ accepted: expect.objectContaining({ extra: {} }) }),
      expect.objectContaining({ extra: {} }),
    );
  });

  it('preserves the 404 response and request identifier', async () => {
    const app = await createTestApp({ config: config(), engine: engine(), log: silentLogger });
    const response = await request(app.getHttpServer())
      .get('/missing')
      .set('x-request-id', 'known-request');

    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: { code: 'NOT_FOUND', message: 'Route not found' } });
    expect(response.headers['x-request-id']).toBe('known-request');
  });

  it('rejects bodies over the configured limit before verification', async () => {
    const paymentEngine = engine();
    const app = await createTestApp({
      config: config({ maxBodySize: '1kb' }),
      engine: paymentEngine,
      log: silentLogger,
    });
    const response = await request(app.getHttpServer())
      .post('/verify')
      .send({ ...body, padding: 'x'.repeat(2048) });

    expect(response.status).toBe(413);
    expect(response.body).toEqual({
      error: { code: 'PAYLOAD_TOO_LARGE', message: 'Request body is too large' },
    });
    expect(paymentEngine.verify).not.toHaveBeenCalled();
  });

  it('rate-limits protected routes but leaves health available', async () => {
    const app = await createTestApp({
      config: config({ rateLimitMax: 1 }),
      engine: engine(),
      log: silentLogger,
    });
    const first = await request(app.getHttpServer()).get('/supported');
    const second = await request(app.getHttpServer()).get('/supported');

    expect(first.status).toBe(200);
    expect(second.status).toBe(429);
    expect(second.body).toEqual({
      error: { code: 'RATE_LIMITED', message: 'Too many requests' },
    });
    expect((await request(app.getHttpServer()).get('/health')).status).toBe(200);
  });
});
