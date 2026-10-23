import type { INestApplication } from '@nestjs/common';
import { createHmac } from 'node:crypto';
import { Keypair } from '@stellar/stellar-sdk';
import type { SettleResponse, SupportedResponse, VerifyResponse } from '@x402/core/types';
import type { Kysely } from 'kysely';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import {
  MemoryRateLimitStore,
  type RateLimitStore,
} from '../src/common/rate-limit/rate-limit-store.js';
import { loadConfig } from '../src/config/facilitator.config.js';
import type { Database } from '../src/models/database.js';
import { CredentialsService } from '../src/modules/credentials/services/credentials.service.js';
import type { PaymentEngine } from '../src/modules/x402/services/engine/payment-engine.js';
import { createSettlementPersistence } from '../src/modules/x402/services/persistence/settlement-persistence.js';
import { asset, exactPaymentXdr, payTo } from './settlement-fixtures.js';
import { createTestDatabase } from './test-database.js';
import { TEST_DATABASE_URL } from './test-env.js';

vi.setConfig({ testTimeout: 15_000 });

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const apps: INestApplication[] = [];
let db: Kysely<Database>;

beforeEach(async () => {
  vi.clearAllMocks();
  db = await createTestDatabase();
});

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await db.destroy();
});

const engine = {
  verify: vi.fn(async () => ({ isValid: true }) as VerifyResponse),
  settle: vi.fn(async () => ({ success: true }) as SettleResponse),
  supported: () =>
    ({
      kinds: [{ x402Version: 2, scheme: 'exact', network: 'stellar:testnet' }],
      extensions: [],
      signers: {},
    }) as SupportedResponse,
} satisfies PaymentEngine;

const requirements = {
  scheme: 'exact',
  network: 'stellar:testnet',
  amount: '10000',
  asset,
  payTo,
  maxTimeoutSeconds: 60,
  extra: { areFeesSponsored: true },
};

/** A well-formed `/verify` or `/settle` body, so only the rate limit can refuse it. */
const paymentBody = () => ({
  x402Version: 2,
  paymentPayload: {
    x402Version: 2,
    accepted: requirements,
    payload: { transaction: exactPaymentXdr() },
  },
  paymentRequirements: requirements,
});

const HASH_KEY = 'h'.repeat(32);

function testConfig(overrides: NodeJS.ProcessEnv = {}) {
  return loadConfig({
    DATABASE_URL: TEST_DATABASE_URL,
    CHANNEL_STORE_URL: 'redis://127.0.0.1:6379',
    STELLAR_NETWORK: 'stellar:testnet',
    FACILITATOR_STELLAR_FEE_BUMP_SECRET: Keypair.random().secret(),
    FACILITATOR_STELLAR_CHANNEL_SECRETS: Keypair.random().secret(),
    RATE_LIMIT_MAX: '2',
    ...overrides,
  });
}

/** An instance on the shared database and the given counter store, allowing two calls a window. */
async function instance(rateLimits: RateLimitStore, overrides: NodeJS.ProcessEnv = {}) {
  const config = testConfig(overrides);
  const persistence = {
    ...createSettlementPersistence(config, log, { db }),
    close: async () => {}, // the test owns the database
  };
  const app = await createApp({ config, engine, persistence, rateLimits, log });
  apps.push(app);
  return app.getHttpServer() as Parameters<typeof request>[0];
}

async function keyOf(http: Parameters<typeof request>[0], domain: string) {
  const registered = await request(http)
    .post('/credentials/register')
    .send({ name: 'Weather API', domain, email: 'dev@example.com' });
  return registered.body.apiKey as string;
}

const supported = (http: Parameters<typeof request>[0], key?: string) => {
  const call = request(http).get('/supported');
  return key ? call.set('authorization', `Bearer ${key}`) : call;
};

describe('x402 rate limits', () => {
  it('share one count per Resource Server across instances', async () => {
    const counters = new MemoryRateLimitStore();
    const [a, b] = [await instance(counters), await instance(counters)];
    const key = await keyOf(a, 'weather.example.com');

    expect((await supported(a, key)).status).toBe(200);
    expect((await supported(b, key)).status).toBe(200);
    const third = await supported(a, key);

    expect(third.status).toBe(429);
    expect(third.body).toEqual({ error: { code: 'RATE_LIMITED', message: 'Too many requests' } });
    expect(third.headers['retry-after']).toMatch(/^\d+$/);
  });

  it('give each Resource Server its own count, even from one IP', async () => {
    const http = await instance(new MemoryRateLimitStore());
    const first = await keyOf(http, 'a.example.com');
    const second = await keyOf(http, 'b.example.com');
    await supported(http, first);
    await supported(http, first);

    expect((await supported(http, first)).status).toBe(429);
    expect((await supported(http, second)).status).toBe(200);
  });

  it('count a request with a bad key against its IP before refusing it', async () => {
    const http = await instance(new MemoryRateLimitStore());
    expect((await supported(http, 'fsk_wrong')).status).toBe(401);
    expect((await supported(http, 'fsk_wrong')).status).toBe(401);

    expect((await supported(http, 'fsk_wrong')).status).toBe(429);
    expect((await supported(http)).status).toBe(429); // same IP, anonymous
  });

  it.each(['verify', 'settle'] as const)(
    'refuse /%s over the limit without reaching the payment engine',
    async (route) => {
      const http = await instance(new MemoryRateLimitStore());
      const key = await keyOf(http, 'weather.example.com');
      const call = () =>
        request(http).post(`/${route}`).set('authorization', `Bearer ${key}`).send(paymentBody());
      expect((await call()).status).toBe(200);
      expect((await call()).status).toBe(200);

      const third = await call();

      expect(third.status).toBe(429);
      expect(third.body).toEqual({ error: { code: 'RATE_LIMITED', message: 'Too many requests' } });
      expect(engine[route]).toHaveBeenCalledTimes(2);
    },
  );

  it('count every route of a Resource Server against one limit', async () => {
    const http = await instance(new MemoryRateLimitStore());
    const key = await keyOf(http, 'weather.example.com');
    expect((await supported(http, key)).status).toBe(200);
    expect((await supported(http, key)).status).toBe(200);

    for (const route of ['verify', 'settle'] as const) {
      const paid = await request(http)
        .post(`/${route}`)
        .set('authorization', `Bearer ${key}`)
        .send(paymentBody());
      expect([route, paid.status]).toEqual([route, 429]);
    }
    expect(engine.verify).not.toHaveBeenCalled();
    expect(engine.settle).not.toHaveBeenCalled();
  });

  it('keep counting a Resource Server across a key rotation', async () => {
    const http = await instance(new MemoryRateLimitStore());
    const oldKey = await keyOf(http, 'weather.example.com');
    const rotated = await request(http)
      .post('/credentials/keys/rotate')
      .set('authorization', `Bearer ${oldKey}`);
    expect(rotated.status).toBe(201);
    const newKey = rotated.body.apiKey as string;

    expect((await supported(http, newKey)).status).toBe(200);
    // The rotation and the call above used the server's two calls; the old key is in its grace period.
    expect((await supported(http, oldKey)).status).toBe(429);
    expect((await supported(http, newKey)).status).toBe(429);
  });

  it('let requests through when the counter store cannot be reached', async () => {
    const down: RateLimitStore = { hit: async () => Promise.reject(new Error('store down')) };
    const http = await instance(down);

    for (let i = 0; i < 4; i += 1) expect((await supported(http)).status).toBe(200);
    expect(log.warn).toHaveBeenCalledWith('rate_limit_store_unavailable', expect.anything());
  });
});

describe('the source IP a limit counts', () => {
  // Every request reaches the app from loopback, which the default TRUST_PROXY trusts as a proxy.
  const from = (http: Parameters<typeof request>[0], forwardedFor: string) =>
    supported(http).set('x-forwarded-for', forwardedFor);

  it('is the nearest untrusted address, so a client cannot choose it by prepending one', async () => {
    const http = await instance(new MemoryRateLimitStore());
    expect((await from(http, '198.51.100.1, 203.0.113.1')).status).toBe(200);
    expect((await from(http, '198.51.100.2, 203.0.113.1')).status).toBe(200);

    expect((await from(http, '198.51.100.3, 203.0.113.1')).status).toBe(429);
  });

  it('gives each client IP its own count', async () => {
    const http = await instance(new MemoryRateLimitStore());
    await from(http, '203.0.113.1');
    await from(http, '203.0.113.1');
    expect((await from(http, '203.0.113.1')).status).toBe(429);

    expect((await from(http, '203.0.113.2')).status).toBe(200);
  });

  it('gives each client IP its own registration count', async () => {
    const http = await instance(new MemoryRateLimitStore(), { REGISTER_RATE_LIMIT_MAX: '1' });
    const register = (forwardedFor: string, domain: string) =>
      request(http)
        .post('/credentials/register')
        .set('x-forwarded-for', forwardedFor)
        .send({ name: 'n', domain, email: 'dev@example.com' });
    expect((await register('203.0.113.1', 'a.example.com')).status).toBe(201);
    expect((await register('203.0.113.1', 'b.example.com')).status).toBe(429);

    expect((await register('203.0.113.2', 'c.example.com')).status).toBe(201);
  });

  it('ignores X-Forwarded-For from a peer TRUST_PROXY does not name', async () => {
    const http = await instance(new MemoryRateLimitStore(), { TRUST_PROXY: '10.0.0.0/8' });
    expect((await from(http, '203.0.113.1')).status).toBe(200);
    expect((await from(http, '203.0.113.2')).status).toBe(200);

    expect((await from(http, '203.0.113.3')).status).toBe(429);
  });
});

describe('registration rate limit', () => {
  it('reports the limit, what is left and the window reset on an allowed registration', async () => {
    const http = await instance(new MemoryRateLimitStore());

    const registered = await request(http)
      .post('/credentials/register')
      .send({ name: 'n', domain: 'a.example.com', email: 'dev@example.com' });

    expect(registered.status).toBe(201);
    expect(registered.headers['ratelimit-limit']).toBe('5');
    expect(registered.headers['ratelimit-remaining']).toBe('4');
    const resetSeconds = Number(registered.headers['ratelimit-reset']);
    expect(resetSeconds).toBeGreaterThan(0);
    expect(resetSeconds).toBeLessThanOrEqual(3_600);
  });

  it('allows registrations again in the next window', async () => {
    let now = Date.UTC(2026, 9, 21, 10, 0, 0);
    const http = await instance(new MemoryRateLimitStore(() => now), {
      REGISTER_RATE_LIMIT_MAX: '1',
    });
    const register = (domain: string) =>
      request(http)
        .post('/credentials/register')
        .send({ name: 'n', domain, email: 'dev@example.com' });
    expect((await register('a.example.com')).status).toBe(201);
    expect((await register('b.example.com')).status).toBe(429);

    now += 3_600_000;

    expect((await register('c.example.com')).status).toBe(201);
  });

  it('counts per IP in the shared store', async () => {
    const counters = new MemoryRateLimitStore();
    const [a, b] = [await instance(counters), await instance(counters)];
    for (const [http, domain] of [
      [a, 'a.example.com'],
      [b, 'b.example.com'],
      [a, 'c.example.com'],
      [b, 'd.example.com'],
      [a, 'e.example.com'],
    ] as const) {
      expect(
        (
          await request(http).post('/credentials/register').send({
            name: 'n',
            domain,
            email: 'dev@example.com',
          })
        ).status,
      ).toBe(201);
    }

    const sixth = await request(b)
      .post('/credentials/register')
      .send({ name: 'n', domain: 'f.example.com', email: 'dev@example.com' });
    expect(sixth.status).toBe(429);
  });

  const down: RateLimitStore = { hit: async () => Promise.reject(new Error('store down')) };
  const register = (http: Parameters<typeof request>[0], domain: string) =>
    request(http)
      .post('/credentials/register')
      .send({ name: 'n', domain, email: 'dev@example.com' });

  it('counts successful registrations in the database while the store is down', async () => {
    const http = await instance(down, { REGISTRATION_IP_HASH_KEY: HASH_KEY });
    for (const domain of ['a', 'b', 'c', 'd', 'e']) {
      expect((await register(http, `${domain}.example.com`)).status).toBe(201);
    }

    const sixth = await register(http, 'f.example.com');

    expect(sixth.status).toBe(429);
    expect(sixth.body).toEqual({
      error: { code: 'RATE_LIMITED', message: 'Too many registrations' },
    });
    expect(sixth.headers['retry-after']).toMatch(/^\d+$/);
    expect(log.warn).toHaveBeenCalledWith('rate_limit_store_unavailable', expect.anything());
  });

  it('does not count a refused registration while the store is down', async () => {
    const http = await instance(down, { REGISTRATION_IP_HASH_KEY: HASH_KEY });
    expect((await register(http, 'a.example.com')).status).toBe(201);
    for (let i = 0; i < 5; i += 1) {
      expect((await register(http, 'a.example.com')).status).toBe(409);
    }
    for (const domain of ['b', 'c', 'd', 'e']) {
      expect((await register(http, `${domain}.example.com`)).status).toBe(201);
    }

    expect((await register(http, 'f.example.com')).status).toBe(429);
  });

  it('lets registrations through while the store is down if no hash key is set', async () => {
    const http = await instance(down);
    for (const domain of ['a', 'b', 'c', 'd', 'e', 'f', 'g']) {
      expect((await register(http, `${domain}.example.com`)).status).toBe(201);
    }
    expect(await db.selectFrom('registrationSource').selectAll().execute()).toEqual([]);
  });

  it('records each successful registration while the store is up, ready for a fallback', async () => {
    const http = await instance(new MemoryRateLimitStore(), { REGISTRATION_IP_HASH_KEY: HASH_KEY });
    await register(http, 'a.example.com');
    await register(http, 'a.example.com'); // refused: the domain is taken

    expect(await db.selectFrom('registrationSource').selectAll().execute()).toHaveLength(1);
  });

  it('stores the keyed HMAC of the source IP, never the IP', async () => {
    const credentials = new CredentialsService(
      db,
      testConfig({ REGISTRATION_IP_HASH_KEY: HASH_KEY }),
    );
    await credentials.register(
      { name: 'n', domain: 'a.example.com', email: 'dev@example.com' },
      '203.0.113.7',
    );

    const rows = await db.selectFrom('registrationSource').select('ipDigest').execute();
    expect(rows.map((row) => Buffer.from(row.ipDigest).toString('hex'))).toEqual([
      createHmac('sha256', HASH_KEY).update('203.0.113.7').digest('hex'),
    ]);
    expect(await credentials.registrationsFrom('203.0.113.7')).toBe(1);
    expect(await credentials.registrationsFrom('203.0.113.8')).toBe(0);
  });
});
