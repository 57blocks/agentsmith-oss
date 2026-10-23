import { createHash, randomBytes } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Keypair } from '@stellar/stellar-sdk';
import type { SettleResponse, SupportedResponse, VerifyResponse } from '@x402/core/types';
import { sql, type Kysely } from 'kysely';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config/facilitator.config.js';
import type { Database } from '../src/models/database.js';
import { ApiCredentialRepository } from '../src/modules/credentials/repositories/api-credential.repository.js';
import { ResourceServerRepository } from '../src/modules/credentials/repositories/resource-server.repository.js';
import type { PaymentEngine } from '../src/modules/x402/services/engine/payment-engine.js';
import { createSettlementPersistence } from '../src/modules/x402/services/persistence/settlement-persistence.js';
import { X402Service } from '../src/modules/x402/services/x402.service.js';
import { SHARED_KEY_RESOURCE_SERVER_ID } from '../src/models/credentials/resource-server.model.js';
import { exactPaymentXdr } from './settlement-fixtures.js';
import { createTestDatabase, createUnreachableTestDatabase } from './test-database.js';
import { TEST_DATABASE_URL } from './test-env.js';
import { MemoryRateLimitStore } from '../src/common/rate-limit/rate-limit-store.js';

vi.setConfig({ testTimeout: 15_000 });

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const apps: INestApplication[] = [];
let db: Kysely<Database>;

beforeEach(async () => {
  db = await createTestDatabase();
});

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await db.destroy();
});

const engine: PaymentEngine = {
  verify: async () => ({ isValid: true }) as VerifyResponse,
  settle: async () => ({ success: true }) as SettleResponse,
  supported: () => ({ kinds: [], extensions: [], signers: {} }) as SupportedResponse,
};

async function appOn(network: 'stellar:testnet' | 'stellar:pubnet', database = db) {
  const config = loadConfig({
    DATABASE_URL: TEST_DATABASE_URL,
    CHANNEL_STORE_URL: 'redis://127.0.0.1:6379',
    STELLAR_NETWORK: network,
    STELLAR_RPC_URL: 'https://rpc.example.com',
    FACILITATOR_STELLAR_FEE_BUMP_SECRET: Keypair.random().secret(),
    FACILITATOR_STELLAR_CHANNEL_SECRETS: Keypair.random().secret(),
  });
  const persistence = {
    ...createSettlementPersistence(config, log, { db: database }),
    close: async () => {}, // the test owns the database
  };
  const app = await createApp({
    config,
    engine,
    persistence,
    rateLimits: new MemoryRateLimitStore(),
    log,
  });
  apps.push(app);
  return app.getHttpServer();
}

/** A Resource Server with one key, stored the way registration stores it. */
async function issuedKey() {
  const server = await new ResourceServerRepository(db).create({
    name: 'Weather API',
    domain: `${randomBytes(4).toString('hex')}.example.com`,
    email: 'dev@example.com',
  });
  const key = `fsk_${randomBytes(32).toString('base64url')}`;
  const credential = await new ApiCredentialRepository(db).issue({
    resourceServerId: server.id,
    secretDigest: createHash('sha256').update(key).digest(),
  });
  return { key, credential };
}

const supported = (server: unknown, key?: string) => {
  const call = request(server as Parameters<typeof request>[0]).get('/supported');
  return key ? call.set('authorization', `Bearer ${key}`) : call;
};

const withAuthorization = (server: unknown, authorization: string) =>
  request(server as Parameters<typeof request>[0])
    .get('/supported')
    .set('authorization', authorization);

const UNAUTHORIZED = { error: { code: 'UNAUTHORIZED', message: 'Bearer token required' } };

describe('API keys on pubnet', () => {
  it('accept a registered key', async () => {
    const server = await appOn('stellar:pubnet');
    const { key } = await issuedKey();

    expect((await supported(server, key)).status).toBe(200);
  });

  it('refuse a missing, unknown or revoked key with the same 401', async () => {
    const server = await appOn('stellar:pubnet');
    const { key, credential } = await issuedKey();
    await new ApiCredentialRepository(db).revoke(credential.id);

    for (const sent of [undefined, 'fsk_unknown', key]) {
      const response = await supported(server, sent);
      expect(response.status).toBe(401);
      expect(response.body).toEqual({
        error: { code: 'UNAUTHORIZED', message: 'Bearer token required' },
      });
    }
  });
});

describe('API keys on testnet', () => {
  it('are optional', async () => {
    expect((await supported(await appOn('stellar:testnet'))).status).toBe(200);
  });

  it('are still checked when sent', async () => {
    const server = await appOn('stellar:testnet');
    const { key, credential } = await issuedKey();
    expect((await supported(server, key)).status).toBe(200);

    await new ApiCredentialRepository(db).revoke(credential.id);
    expect((await supported(server, key)).status).toBe(401);
  });
});

describe('a credential store that cannot be read', () => {
  it('answers 503 and never authenticates', async () => {
    const server = await appOn('stellar:pubnet', await createUnreachableTestDatabase());

    const response = await supported(server, 'fsk_anything');
    expect(response.status).toBe(503);
    expect(response.body.error.code).toBe('CREDENTIAL_STORE_UNAVAILABLE');
  });
});

describe('API key lookup', () => {
  it('refuses a key whose server is disabled with the same 401', async () => {
    const server = await appOn('stellar:pubnet');
    const { key, credential } = await issuedKey();
    await new ResourceServerRepository(db).setStatus(credential.resourceServerId, 'disabled');

    const response = await supported(server, key);

    expect(response.status).toBe(401);
    expect(response.body).toEqual(UNAUTHORIZED);
  });

  it('refuses a key whose grace period has ended', async () => {
    const server = await appOn('stellar:pubnet');
    const { key, credential } = await issuedKey();
    await sql`update api_credentials set expires_at = now() - interval '1 second'
      where id = ${credential.id}`.execute(db);

    expect((await supported(server, key)).status).toBe(401);
  });

  it('reads the scheme in any case and the key after any run of spaces', async () => {
    const server = await appOn('stellar:pubnet');
    const { key } = await issuedKey();

    expect((await withAuthorization(server, `bearer   ${key}`)).status).toBe(200);
  });

  it.each(['stellar:pubnet', 'stellar:testnet'] as const)(
    'treats a Basic credential on %s as an unknown key',
    async (network) => {
      const server = await appOn(network);
      const { key } = await issuedKey();

      const response = await withAuthorization(server, `Basic ${key}`);

      expect(response.status).toBe(401);
      expect(response.body).toEqual(UNAUTHORIZED);
    },
  );

  it('refuses a Bearer scheme without a key on pubnet', async () => {
    const server = await appOn('stellar:pubnet');

    const response = await withAuthorization(server, 'Bearer ');

    expect(response.status).toBe(401);
    expect(response.body).toEqual(UNAUTHORIZED);
  });
});

describe('the caller handed to settlement', () => {
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

  function settleSpy() {
    return vi.spyOn(X402Service.prototype, 'settle').mockResolvedValue({
      success: true,
      transaction: 'abc',
      network: 'stellar:testnet',
    });
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('is the shared placeholder server for an anonymous testnet request', async () => {
    const settle = settleSpy();
    const server = await appOn('stellar:testnet');

    const response = await request(server).post('/settle').send(body);

    expect(response.status).toBe(200);
    expect(settle.mock.calls[0]?.[1]).toEqual({ resourceServerId: SHARED_KEY_RESOURCE_SERVER_ID });
  });

  it('is the key’s server and credential when a key is sent', async () => {
    const settle = settleSpy();
    const server = await appOn('stellar:testnet');
    const { key, credential } = await issuedKey();

    await request(server).post('/settle').set('authorization', `Bearer ${key}`).send(body);

    expect(settle.mock.calls[0]?.[1]).toEqual({
      resourceServerId: credential.resourceServerId,
      credentialId: credential.id,
    });
  });
});

describe('key self-service with a credential store that cannot be read', () => {
  it.each([
    ['rotation', 'post', '/credentials/keys/rotate'],
    ['revocation', 'delete', '/credentials/keys/current'],
  ] as const)('answers %s with 503', async (_label, method, path) => {
    const server = await appOn('stellar:pubnet', await createUnreachableTestDatabase());

    const response = await request(server)[method](path).set('authorization', 'Bearer fsk_any');

    expect(response.status).toBe(503);
    expect(response.body).toEqual({
      error: { code: 'CREDENTIAL_STORE_UNAVAILABLE', message: 'Credentials cannot be checked' },
    });
  });
});
