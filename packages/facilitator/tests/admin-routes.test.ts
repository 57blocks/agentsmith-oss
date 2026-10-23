import type { INestApplication } from '@nestjs/common';
import { Keypair } from '@stellar/stellar-sdk';
import type { SettleResponse, SupportedResponse, VerifyResponse } from '@x402/core/types';
import type { Kysely } from 'kysely';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config/facilitator.config.js';
import type { Database } from '../src/models/database.js';
import type { PaymentEngine } from '../src/modules/x402/services/engine/payment-engine.js';
import { createSettlementPersistence } from '../src/modules/x402/services/persistence/settlement-persistence.js';
import { AdminAuditRepository } from '../src/modules/credentials/repositories/admin-audit.repository.js';
import { ResourceServerRepository } from '../src/modules/credentials/repositories/resource-server.repository.js';
import { createTestDatabase } from './test-database.js';
import { TEST_DATABASE_URL } from './test-env.js';
import { MemoryRateLimitStore } from '../src/common/rate-limit/rate-limit-store.js';

vi.setConfig({ testTimeout: 15_000 });

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const apps: INestApplication[] = [];
const ALICE = 'a'.repeat(40);
let db: Kysely<Database>;
let http: Parameters<typeof request>[0];

const engine: PaymentEngine = {
  verify: async () => ({ isValid: true }) as VerifyResponse,
  settle: async () => ({ success: true }) as SettleResponse,
  supported: () => ({ kinds: [], extensions: [], signers: {} }) as SupportedResponse,
};

/** Starts an app on the test database with these admins; it becomes `http`. */
async function start(admins: Record<string, string>) {
  const config = loadConfig({
    DATABASE_URL: TEST_DATABASE_URL,
    CHANNEL_STORE_URL: 'redis://127.0.0.1:6379',
    STELLAR_NETWORK: 'stellar:pubnet',
    STELLAR_RPC_URL: 'https://rpc.example.com',
    FACILITATOR_STELLAR_FEE_BUMP_SECRET: Keypair.random().secret(),
    FACILITATOR_STELLAR_CHANNEL_SECRETS: Keypair.random().secret(),
    ...(Object.keys(admins).length > 0 ? { ADMIN_API_KEYS: JSON.stringify(admins) } : {}),
  });
  const persistence = {
    ...createSettlementPersistence(config, log, { db }),
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
  http = app.getHttpServer();
}

beforeEach(async () => {
  db = await createTestDatabase();
  await start({ alice: ALICE });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await db.destroy();
});

const bearer = (call: request.Test, key: string) => call.set('authorization', `Bearer ${key}`);
const works = async (key: string) =>
  (await bearer(request(http).get('/supported'), key)).status === 200;

async function registered(domain = 'weather.example.com') {
  const response = await request(http)
    .post('/credentials/register')
    .send({ name: 'Weather API', domain, email: 'dev@example.com' });
  return response.body as { resourceServerId: string; apiKey: string };
}

const audit = () =>
  db
    .selectFrom('adminAudit')
    .select(['actor', 'action', 'resourceServerId', 'credentialId'])
    .orderBy('createdAt')
    .execute();

describe('POST /admin/servers/:id/keys', () => {
  it('issues a key for a server that revoked its own, and audits it under the admin', async () => {
    const { resourceServerId, apiKey } = await registered();
    await bearer(request(http).delete('/credentials/keys/current'), apiKey);

    const issued = await bearer(
      request(http).post(`/admin/servers/${resourceServerId}/keys`),
      ALICE,
    );

    expect(issued.status).toBe(201);
    expect(await works(issued.body.apiKey)).toBe(true);
    expect(await audit()).toEqual([
      {
        actor: 'alice',
        action: 'issue_key',
        resourceServerId,
        credentialId: issued.body.credentialId,
      },
    ]);
  });

  it('gives the server’s current key the rotation grace period', async () => {
    const { resourceServerId, apiKey } = await registered();

    await bearer(request(http).post(`/admin/servers/${resourceServerId}/keys`), ALICE);

    expect(await works(apiKey)).toBe(true);
    const graced = await db
      .selectFrom('apiCredentials')
      .select('expiresAt')
      .where('expiresAt', 'is not', null)
      .execute();
    expect(graced).toHaveLength(1);
  });

  it('answers 404 for an unknown server', async () => {
    const unknown = '00000000-0000-0000-0000-00000000abcd';
    const response = await bearer(request(http).post(`/admin/servers/${unknown}/keys`), ALICE);
    expect(response.status).toBe(404);
  });

  it('refuses a disabled server with 409, issuing no key and writing no audit row', async () => {
    const { resourceServerId, apiKey } = await registered();
    await new ResourceServerRepository(db).setStatus(resourceServerId, 'disabled');

    const response = await bearer(
      request(http).post(`/admin/servers/${resourceServerId}/keys`),
      ALICE,
    );

    expect(response.status).toBe(409);
    expect(response.body).toEqual({
      error: { code: 'SERVER_DISABLED', message: 'The Resource Server is disabled' },
    });
    const keys = await db.selectFrom('apiCredentials').select(['id', 'expiresAt']).execute();
    expect(keys).toHaveLength(1);
    expect(keys[0]?.expiresAt).toBeNull();
    expect(await audit()).toEqual([]);

    await new ResourceServerRepository(db).setStatus(resourceServerId, 'active');
    expect(await works(apiKey)).toBe(true);
  });

  it('issues a key again once the server is enabled', async () => {
    const { resourceServerId } = await registered();
    const servers = new ResourceServerRepository(db);
    await servers.setStatus(resourceServerId, 'disabled');
    await servers.setStatus(resourceServerId, 'active');

    const response = await bearer(
      request(http).post(`/admin/servers/${resourceServerId}/keys`),
      ALICE,
    );

    expect(response.status).toBe(201);
    expect(await works(response.body.apiKey as string)).toBe(true);
  });
});

describe('DELETE /admin/keys/:id', () => {
  it('revokes any server’s key at once, and audits it under the admin', async () => {
    const { resourceServerId, apiKey } = await registered();
    const [key] = await db.selectFrom('apiCredentials').select('id').execute();

    const revoked = await bearer(request(http).delete(`/admin/keys/${key!.id}`), ALICE);

    expect(revoked.status).toBe(204);
    expect(await works(apiKey)).toBe(false);
    expect(await audit()).toEqual([
      { actor: 'alice', action: 'revoke_key', resourceServerId, credentialId: key!.id },
    ]);
  });

  it('answers 404 for a key that is unknown or already revoked', async () => {
    await registered();
    const [key] = await db.selectFrom('apiCredentials').select('id').execute();
    await bearer(request(http).delete(`/admin/keys/${key!.id}`), ALICE);

    const again = await bearer(request(http).delete(`/admin/keys/${key!.id}`), ALICE);
    expect(again.status).toBe(404);
  });
});

describe('a key replaced before an admin revocation', () => {
  it('cannot rotate; only a key the admin issues next can', async () => {
    const { resourceServerId, apiKey: replaced } = await registered();
    const replacement = await bearer(request(http).post('/credentials/keys/rotate'), replaced);
    const credentialId = (
      await db
        .selectFrom('apiCredentials')
        .select('id')
        .where('expiresAt', 'is', null)
        .executeTakeFirstOrThrow()
    ).id;
    expect(replacement.status).toBe(201);
    await bearer(request(http).delete(`/admin/keys/${credentialId}`), ALICE);

    const again = await bearer(request(http).post('/credentials/keys/rotate'), replaced);
    expect(again.status).toBe(409);

    const issued = await bearer(
      request(http).post(`/admin/servers/${resourceServerId}/keys`),
      ALICE,
    );
    const rotated = await bearer(
      request(http).post('/credentials/keys/rotate'),
      issued.body.apiKey,
    );
    expect(rotated.status).toBe(201);
  });
});

describe('admin authentication', () => {
  it('refuses a missing or wrong admin key, and a Resource Server key, with 401', async () => {
    const { resourceServerId, apiKey } = await registered();
    const route = `/admin/servers/${resourceServerId}/keys`;

    expect((await request(http).post(route)).status).toBe(401);
    expect((await bearer(request(http).post(route), 'b'.repeat(40))).status).toBe(401);
    expect((await bearer(request(http).post(route), apiKey)).status).toBe(401);
    expect(await audit()).toEqual([]);
  });
});

describe('admin ids', () => {
  it('accept an upper-case UUID', async () => {
    const { resourceServerId } = await registered();
    const issued = await bearer(
      request(http).post(`/admin/servers/${resourceServerId.toUpperCase()}/keys`),
      ALICE,
    );
    expect(issued.status).toBe(201);
  });

  it.each([
    'not-a-uuid',
    '00000000-0000-0000-0000-00000000abc',
    ' 00000000-0000-0000-0000-00000000abcd',
  ])('answer %j with the final 404 body and no audit row', async (id) => {
    const response = await bearer(
      request(http).delete(`/admin/keys/${encodeURIComponent(id)}`),
      ALICE,
    );
    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: { code: 'NOT_FOUND', message: 'Route not found' } });
    expect(await audit()).toEqual([]);
  });

  it('answer 401 to a wrong admin key before looking at a malformed id', async () => {
    const response = await bearer(request(http).delete('/admin/keys/not-a-uuid'), 'b'.repeat(40));
    expect(response.status).toBe(401);
  });
});

describe('admin key issues over time', () => {
  const issue = (resourceServerId: string, admin = ALICE) =>
    bearer(request(http).post(`/admin/servers/${resourceServerId}/keys`), admin);

  it('gives the key it issued first the grace period when it issues again, auditing both', async () => {
    const { resourceServerId } = await registered();
    const first = (await issue(resourceServerId)).body;

    const second = (await issue(resourceServerId)).body;

    expect(await works(first.apiKey)).toBe(true);
    expect(await works(second.apiKey)).toBe(true);
    const unexpiring = await db
      .selectFrom('apiCredentials')
      .select('id')
      .where('expiresAt', 'is', null)
      .execute();
    expect(unexpiring).toEqual([{ id: second.credentialId }]);
    expect(await audit()).toEqual([
      { actor: 'alice', action: 'issue_key', resourceServerId, credentialId: first.credentialId },
      { actor: 'alice', action: 'issue_key', resourceServerId, credentialId: second.credentialId },
    ]);
  });

  it('returns a credential id that revokes the issued key', async () => {
    const { resourceServerId } = await registered();
    const issued = (await issue(resourceServerId)).body;

    const revoked = await bearer(request(http).delete(`/admin/keys/${issued.credentialId}`), ALICE);

    expect(revoked.status).toBe(204);
    expect(await works(issued.apiKey)).toBe(false);
  });

  it('issues no key and graces nothing when its audit row cannot be written', async () => {
    const { resourceServerId, apiKey } = await registered();
    vi.spyOn(AdminAuditRepository.prototype, 'record').mockRejectedValueOnce(
      new Error('disk full'),
    );

    const failed = await issue(resourceServerId);

    expect(failed.status).toBe(500);
    const keys = await db.selectFrom('apiCredentials').select('expiresAt').execute();
    expect(keys).toEqual([{ expiresAt: null }]);
    expect(await works(apiKey)).toBe(true);
  });
});

describe('admin key revocations over time', () => {
  it('revokes a key in its grace period at once, leaving its replacement working', async () => {
    const { apiKey: oldKey } = await registered();
    const [old] = await db.selectFrom('apiCredentials').select('id').execute();
    const newKey = (await bearer(request(http).post('/credentials/keys/rotate'), oldKey)).body
      .apiKey as string;

    const revoked = await bearer(request(http).delete(`/admin/keys/${old!.id}`), ALICE);

    expect(revoked.status).toBe(204);
    expect(await works(oldKey)).toBe(false);
    expect(await works(newKey)).toBe(true);
  });

  it('keeps the key working when its audit row cannot be written', async () => {
    const { apiKey } = await registered();
    const [key] = await db.selectFrom('apiCredentials').select('id').execute();
    vi.spyOn(AdminAuditRepository.prototype, 'record').mockRejectedValueOnce(
      new Error('disk full'),
    );

    const failed = await bearer(request(http).delete(`/admin/keys/${key!.id}`), ALICE);

    expect(failed.status).toBe(500);
    expect(await works(apiKey)).toBe(true);
    expect(await audit()).toEqual([]);
  });
});

describe('admin names', () => {
  it('audit each action under the admin whose key it sent', async () => {
    const BOB = 'b'.repeat(40);
    await start({ alice: ALICE, bob: BOB });
    const { resourceServerId } = await registered();

    const issued = await bearer(request(http).post(`/admin/servers/${resourceServerId}/keys`), BOB);

    expect(issued.status).toBe(201);
    expect(await audit()).toEqual([
      {
        actor: 'bob',
        action: 'issue_key',
        resourceServerId,
        credentialId: issued.body.credentialId,
      },
    ]);
  });

  it('admit no one when no admin keys are configured', async () => {
    await start({});
    const { resourceServerId } = await registered();

    const response = await bearer(
      request(http).post(`/admin/servers/${resourceServerId}/keys`),
      ALICE,
    );

    expect(response.status).toBe(401);
    expect(response.body).toEqual({
      error: { code: 'UNAUTHORIZED', message: 'Admin token required' },
    });
    expect(await audit()).toEqual([]);
  });
});
