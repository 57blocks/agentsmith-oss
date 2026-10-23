import type { INestApplication } from '@nestjs/common';
import { Keypair } from '@stellar/stellar-sdk';
import type { SettleResponse, SupportedResponse, VerifyResponse } from '@x402/core/types';
import { createHash } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config/facilitator.config.js';
import type { Database } from '../src/models/database.js';
import type { PaymentEngine } from '../src/modules/x402/services/engine/payment-engine.js';
import { createSettlementPersistence } from '../src/modules/x402/services/persistence/settlement-persistence.js';
import { ApiCredentialRepository } from '../src/modules/credentials/repositories/api-credential.repository.js';
import { ResourceServerRepository } from '../src/modules/credentials/repositories/resource-server.repository.js';
import { createTestDatabase } from './test-database.js';
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
  vi.restoreAllMocks();
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await db.destroy();
});

const engine: PaymentEngine = {
  verify: async () => ({ isValid: true }) as VerifyResponse,
  settle: async () => ({ success: true }) as SettleResponse,
  supported: () => ({ kinds: [], extensions: [], signers: {} }) as SupportedResponse,
};

async function server(env: NodeJS.ProcessEnv = {}) {
  const config = loadConfig({
    DATABASE_URL: TEST_DATABASE_URL,
    CHANNEL_STORE_URL: 'redis://127.0.0.1:6379',
    STELLAR_NETWORK: 'stellar:pubnet',
    STELLAR_RPC_URL: 'https://rpc.example.com',
    FACILITATOR_STELLAR_FEE_BUMP_SECRET: Keypair.random().secret(),
    FACILITATOR_STELLAR_CHANNEL_SECRETS: Keypair.random().secret(),
    ...env,
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
  // Listening up front lets concurrent requests share one server instead of each starting it.
  await app.listen(0, '127.0.0.1');
  apps.push(app);
  return app.getHttpServer();
}

const registration = (overrides: Record<string, unknown> = {}) => ({
  name: 'Weather API',
  domain: 'weather.example.com',
  email: 'dev@weather.example.com',
  ...overrides,
});

function register(http: unknown, body: object) {
  return request(http as Parameters<typeof request>[0])
    .post('/credentials/register')
    .send(body);
}

describe('POST /credentials/register', () => {
  it('returns a key that authenticates on pubnet at once', async () => {
    const http = await server();

    const registered = await register(http, registration());

    expect(registered.status).toBe(201);
    expect(registered.body.apiKey).toMatch(/^fsk_[A-Za-z0-9_-]{43}$/);
    const supported = await request(http)
      .get('/supported')
      .set('authorization', `Bearer ${registered.body.apiKey}`);
    expect(supported.status).toBe(200);
  });

  it('stores the domain lower-case without a trailing dot, and refuses it again in any case', async () => {
    const http = await server();
    await register(http, registration({ domain: 'Weather.Example.COM.' }));

    const again = await register(http, registration({ domain: 'weather.example.com' }));

    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('DOMAIN_TAKEN');
    const [stored] = await db
      .selectFrom('resourceServer')
      .select(['domain', 'email'])
      .where('domain', 'like', '%weather%')
      .execute();
    expect(stored).toEqual({ domain: 'weather.example.com', email: 'dev@weather.example.com' });
  });

  it.each([
    ['a URL', { domain: 'https://weather.example.com/api' }],
    ['a port', { domain: 'weather.example.com:443' }],
    ['an IP address', { domain: '10.0.0.1' }],
    ['a malformed email', { email: 'not-an-email' }],
    ['no name', { name: '' }],
  ])('refuses %s with 400', async (_label, overrides) => {
    const http = await server();
    const refused = await register(http, registration(overrides));

    expect(refused.status).toBe(400);
    expect(refused.body.error.code).toBe('INVALID_REQUEST');
  });

  it('limits registrations per IP', async () => {
    const http = await server({ REGISTER_RATE_LIMIT_MAX: '2' });
    await register(http, registration({ domain: 'a.example.com' }));
    await register(http, registration({ domain: 'b.example.com' }));

    const third = await register(http, registration({ domain: 'c.example.com' }));

    expect(third.status).toBe(429);
  });
});

describe('registration storage', () => {
  it('registers a domain once when two requests race for it', async () => {
    const http = await server();

    const statuses = (
      await Promise.all([register(http, registration()), register(http, registration())])
    ).map((response) => response.status);

    expect(statuses.sort()).toEqual([201, 409]);
    const servers = await db
      .selectFrom('resourceServer')
      .select('id')
      .where('domain', '=', 'weather.example.com')
      .execute();
    expect(servers).toHaveLength(1);
    const keys = await db.selectFrom('apiCredentials').select('resourceServerId').execute();
    expect(keys).toEqual([{ resourceServerId: servers[0]?.id }]);
  });

  it('keeps no server when its first key cannot be stored', async () => {
    vi.spyOn(ApiCredentialRepository.prototype, 'issue').mockRejectedValueOnce(
      new Error('disk full'),
    );
    const http = await server();

    const failed = await register(http, registration());

    expect(failed.status).toBe(500);
    const servers = await db
      .selectFrom('resourceServer')
      .select('id')
      .where('domain', '=', 'weather.example.com')
      .execute();
    expect(servers).toEqual([]);
  });

  it('gives each server its own key and stores only its SHA-256 digest', async () => {
    const http = await server();
    const first = (await register(http, registration({ domain: 'a.example.com' }))).body;
    const second = (await register(http, registration({ domain: 'b.example.com' }))).body;

    expect(first.apiKey).not.toBe(second.apiKey);
    const stored = await db
      .selectFrom('apiCredentials')
      .select('secretDigest')
      .where('resourceServerId', '=', first.resourceServerId)
      .execute();
    expect(stored.map((row) => Buffer.from(row.secretDigest).toString('hex'))).toEqual([
      createHash('sha256').update(first.apiKey).digest('hex'),
    ]);
  });

  it('never logs the issued key or its digest', async () => {
    const http = await server();

    const { apiKey } = (await register(http, registration())).body;
    await withKey(request(http).get('/supported'), apiKey);

    const logged = JSON.stringify([log.info, log.warn, log.error].map((fn) => fn.mock.calls));
    expect(logged).not.toContain(apiKey);
    expect(logged).not.toContain(createHash('sha256').update(apiKey).digest('hex'));
  });
});

function withKey(call: request.Test, key: string) {
  return call.set('authorization', `Bearer ${key}`);
}

async function registeredKey(http: unknown) {
  return (await register(http, registration())).body.apiKey as string;
}

describe('POST /credentials/keys/rotate', () => {
  it('returns a new key and lets the old one work for ten more minutes', async () => {
    const http = await server();
    const oldKey = await registeredKey(http);

    const rotated = await withKey(request(http).post('/credentials/keys/rotate'), oldKey);

    expect(rotated.status).toBe(201);
    const newKey = rotated.body.apiKey as string;
    expect(newKey).not.toBe(oldKey);
    for (const key of [newKey, oldKey]) {
      expect((await withKey(request(http).get('/supported'), key)).status).toBe(200);
    }
    const expiries = await db
      .selectFrom('apiCredentials')
      .select('expiresAt')
      .where('expiresAt', 'is not', null)
      .execute();
    expect(expiries).toHaveLength(1);
    const inMs = expiries[0]!.expiresAt!.getTime() - Date.now();
    expect(inMs).toBeGreaterThan(9 * 60_000);
    expect(inMs).toBeLessThanOrEqual(10 * 60_000);
  });

  it('refuses to rotate a key that is already being replaced', async () => {
    const http = await server();
    const oldKey = await registeredKey(http);
    await withKey(request(http).post('/credentials/keys/rotate'), oldKey);

    const again = await withKey(request(http).post('/credentials/keys/rotate'), oldKey);

    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('NOT_CURRENT_KEY');
  });

  it('does not let a replaced key rotate again after its replacement is revoked', async () => {
    const http = await server();
    const replaced = await registeredKey(http);
    const replacement = (await withKey(request(http).post('/credentials/keys/rotate'), replaced))
      .body.apiKey as string;
    await withKey(request(http).delete('/credentials/keys/current'), replacement);

    const again = await withKey(request(http).post('/credentials/keys/rotate'), replaced);

    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('NOT_CURRENT_KEY');
    expect((await withKey(request(http).get('/supported'), replaced)).status).toBe(200);
  });

  it('needs a key even on testnet', async () => {
    const http = await server({ STELLAR_NETWORK: 'stellar:testnet' });
    expect((await request(http).post('/credentials/keys/rotate')).status).toBe(401);
  });
});

describe('rotation over time', () => {
  /** Ends every grace period now, as if ten minutes had passed. */
  const graceEnds = () =>
    sql`update api_credentials set expires_at = now() - interval '1 second'
      where expires_at is not null`.execute(db);

  it('stops accepting the old key once its grace period ends, while the new key works', async () => {
    const http = await server();
    const oldKey = await registeredKey(http);
    const newKey = (await withKey(request(http).post('/credentials/keys/rotate'), oldKey)).body
      .apiKey as string;

    await graceEnds();

    expect((await withKey(request(http).get('/supported'), oldKey)).status).toBe(401);
    expect((await withKey(request(http).get('/supported'), newKey)).status).toBe(200);
  });

  it('refuses to rotate a key whose grace period has ended, with 401', async () => {
    const http = await server();
    const oldKey = await registeredKey(http);
    await withKey(request(http).post('/credentials/keys/rotate'), oldKey);
    await graceEnds();

    const again = await withKey(request(http).post('/credentials/keys/rotate'), oldKey);

    expect(again.status).toBe(401);
  });

  it('lets the new key rotate in turn, leaving one current key', async () => {
    const http = await server();
    const first = await registeredKey(http);
    const second = (await withKey(request(http).post('/credentials/keys/rotate'), first)).body
      .apiKey as string;

    const third = await withKey(request(http).post('/credentials/keys/rotate'), second);

    expect(third.status).toBe(201);
    for (const key of [first, second, third.body.apiKey as string]) {
      expect((await withKey(request(http).get('/supported'), key)).status).toBe(200);
    }
    const unexpiring = await db
      .selectFrom('apiCredentials')
      .select('id')
      .where('expiresAt', 'is', null)
      .execute();
    expect(unexpiring).toHaveLength(1);
    const secondAgain = await withKey(request(http).post('/credentials/keys/rotate'), second);
    expect(secondAgain.status).toBe(409);
  });

  it('lets only one of two racing rotations of the same key succeed', async () => {
    const http = await server();
    const key = await registeredKey(http);

    const statuses = (
      await Promise.all([
        withKey(request(http).post('/credentials/keys/rotate'), key),
        withKey(request(http).post('/credentials/keys/rotate'), key),
      ])
    ).map((response) => response.status);

    expect(statuses.sort()).toEqual([201, 409]);
    const unexpiring = await db
      .selectFrom('apiCredentials')
      .select('id')
      .where('expiresAt', 'is', null)
      .execute();
    expect(unexpiring).toHaveLength(1);
  });

  it('refuses an unknown key with 401', async () => {
    const http = await server();

    const response = await withKey(request(http).post('/credentials/keys/rotate'), 'fsk_unknown');

    expect(response.status).toBe(401);
  });

  it('refuses a revoked key with 401', async () => {
    const http = await server();
    const key = await registeredKey(http);
    await withKey(request(http).delete('/credentials/keys/current'), key);

    const response = await withKey(request(http).post('/credentials/keys/rotate'), key);

    expect(response.status).toBe(401);
  });

  it('refuses a key of a disabled server with 401', async () => {
    const http = await server();
    const registered = (await register(http, registration())).body;
    await new ResourceServerRepository(db).setStatus(registered.resourceServerId, 'disabled');

    const response = await withKey(
      request(http).post('/credentials/keys/rotate'),
      registered.apiKey,
    );

    expect(response.status).toBe(401);
  });
});

describe('DELETE /credentials/keys/current', () => {
  it('revokes the presented key at once', async () => {
    const http = await server();
    const key = await registeredKey(http);

    const revoked = await withKey(request(http).delete('/credentials/keys/current'), key);

    expect(revoked.status).toBe(204);
    expect((await withKey(request(http).get('/supported'), key)).status).toBe(401);
  });

  it('needs a key even on testnet', async () => {
    const http = await server({ STELLAR_NETWORK: 'stellar:testnet' });
    expect((await request(http).delete('/credentials/keys/current')).status).toBe(401);
  });
});

describe('revoking the presented key', () => {
  it('revokes a key in its grace period at once, leaving its replacement working', async () => {
    const http = await server();
    const oldKey = await registeredKey(http);
    const newKey = (await withKey(request(http).post('/credentials/keys/rotate'), oldKey)).body
      .apiKey as string;

    const revoked = await withKey(request(http).delete('/credentials/keys/current'), oldKey);

    expect(revoked.status).toBe(204);
    expect((await withKey(request(http).get('/supported'), oldKey)).status).toBe(401);
    expect((await withKey(request(http).get('/supported'), newKey)).status).toBe(200);
  });

  it('answers a second revocation of the same key with 401', async () => {
    const http = await server();
    const key = await registeredKey(http);
    await withKey(request(http).delete('/credentials/keys/current'), key);

    const again = await withKey(request(http).delete('/credentials/keys/current'), key);

    expect(again.status).toBe(401);
  });

  it('leaves a server that revoked its only key unable to rotate or register its domain again', async () => {
    const http = await server();
    const key = await registeredKey(http);
    await withKey(request(http).delete('/credentials/keys/current'), key);

    expect((await withKey(request(http).post('/credentials/keys/rotate'), key)).status).toBe(401);
    expect((await register(http, registration())).status).toBe(409);
  });
});

describe('registration input', () => {
  const stored = () =>
    db
      .selectFrom('resourceServer')
      .select(['name', 'domain', 'email'])
      .where('domain', 'like', '%.example.com')
      .execute();

  it.each([
    ['a missing body', undefined],
    ['a null body', null],
    ['an array body', [registration()]],
    ['a number for the name', registration({ name: 42 })],
    ['a name of 101 characters', registration({ name: 'n'.repeat(101) })],
    ['a name of 51 emoji, 102 UTF-16 units', registration({ name: '😀'.repeat(51) })],
    ['an email over 254 characters', registration({ email: `${'a'.repeat(250)}@x.io` })],
  ])('refuses %s with 400 and writes nothing', async (_label, body) => {
    const http = await server();
    const call = request(http).post('/credentials/register');
    const refused = await (body === undefined ? call : call.send(body as object));

    expect(refused.status).toBe(400);
    expect(refused.body.error.code).toBe('INVALID_REQUEST');
    expect(await stored()).toEqual([]);
  });

  it('accepts a name of 50 emoji, trims fields, keeps the email case and ignores unknown fields', async () => {
    const http = await server();
    const accepted = await register(
      http,
      registration({
        name: `  ${'😀'.repeat(50)}  `,
        email: '  Dev@Weather.Example.COM ',
        role: 'admin',
      }),
    );

    expect(accepted.status).toBe(201);
    expect(await stored()).toEqual([
      { name: '😀'.repeat(50), domain: 'weather.example.com', email: 'Dev@Weather.Example.COM' },
    ]);
  });

  it('never echoes the submitted value in the error', async () => {
    const http = await server();
    const refused = await register(http, registration({ email: 'secret-value@@nowhere' }));

    expect(refused.status).toBe(400);
    expect(JSON.stringify(refused.body)).not.toContain('secret-value');
  });
});

describe('registration field rules', () => {
  /** A host name of labels with these lengths, ending in an alphabetic top-level label. */
  const host = (lengths: number[]) =>
    lengths.map((length, i) => (i === lengths.length - 1 ? 'a' : 'b').repeat(length)).join('.');

  it.each([
    ['a name of only spaces', { name: '   ' }],
    ['a single-label domain', { domain: 'localhost' }],
    ['a domain label starting with a hyphen', { domain: '-weather.example.com' }],
    ['a domain label ending with a hyphen', { domain: 'weather-.example.com' }],
    ['a domain label of 64 characters', { domain: `${'b'.repeat(64)}.example.com` }],
    ['a domain of 254 characters', { domain: host([63, 63, 63, 62]) }],
    ['an underscore in the domain', { domain: 'my_api.example.com' }],
    ['a domain starting with a dot', { domain: '.example.com' }],
    ['an email with two dots in a row', { email: 'dev..ops@example.com' }],
    ['an email starting with a dot', { email: '.dev@example.com' }],
    ['an email at an IP address', { email: 'dev@10.0.0.1' }],
    ['an object for the domain', { domain: { host: 'weather.example.com' } }],
    ['an array for the email', { email: ['dev@example.com'] }],
  ])('refuses %s with 400 and writes nothing', async (_label, overrides) => {
    const http = await server();

    const refused = await register(http, registration(overrides));

    expect(refused.status).toBe(400);
    expect(refused.body.error.code).toBe('INVALID_REQUEST');
    expect(await db.selectFrom('apiCredentials').select('id').execute()).toEqual([]);
  });

  it('names the rule a bad domain breaks', async () => {
    const http = await server();

    const refused = await register(http, registration({ domain: 'localhost' }));

    expect(refused.body).toEqual({
      error: { code: 'INVALID_REQUEST', message: 'domain: must be a bare host name' },
    });
  });

  it('accepts a name of exactly 100 characters', async () => {
    const http = await server();

    const accepted = await register(http, registration({ name: 'n'.repeat(100) }));

    expect(accepted.status).toBe(201);
    const row = await db
      .selectFrom('resourceServer')
      .select('name')
      .where('id', '=', accepted.body.resourceServerId)
      .executeTakeFirst();
    expect(row).toEqual({ name: 'n'.repeat(100) });
  });

  it.each([
    ['a punycode label', 'xn--bcher-kva.example.com'],
    ['a domain label of 63 characters', `${'b'.repeat(63)}.example.com`],
    ['a domain of 253 characters', host([63, 63, 63, 61])],
  ])('accepts %s', async (_label, domain) => {
    const http = await server();

    const accepted = await register(http, registration({ domain }));

    expect(accepted.status).toBe(201);
    const row = await db
      .selectFrom('resourceServer')
      .select('domain')
      .where('id', '=', accepted.body.resourceServerId)
      .executeTakeFirst();
    expect(row).toEqual({ domain });
  });
});
