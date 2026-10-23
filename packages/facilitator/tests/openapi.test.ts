import type { INestApplication } from '@nestjs/common';
import { Keypair } from '@stellar/stellar-sdk';
import type { SettleResponse, SupportedResponse, VerifyResponse } from '@x402/core/types';
import type { Kysely } from 'kysely';
import { readFileSync } from 'node:fs';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { MemoryRateLimitStore } from '../src/common/rate-limit/rate-limit-store.js';
import { loadConfig } from '../src/config/facilitator.config.js';
import type { Database } from '../src/models/database.js';
import type { PaymentEngine } from '../src/modules/x402/services/engine/payment-engine.js';
import { createSettlementPersistence } from '../src/modules/x402/services/persistence/settlement-persistence.js';
import { createTestDatabase } from './test-database.js';
import { TEST_DATABASE_URL } from './test-env.js';

vi.setConfig({ testTimeout: 15_000, hookTimeout: 30_000 });

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const engine: PaymentEngine = {
  verify: async () => ({ isValid: true }) as VerifyResponse,
  settle: async () => ({ success: true }) as SettleResponse,
  supported: () => ({ kinds: [], extensions: [], signers: {} }) as SupportedResponse,
};

let db: Kysely<Database>;
let app: INestApplication;
let http: Parameters<typeof request>[0];
// The OpenAPI document as served; typed loosely because it is the subject under test.
let doc: Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- inspecting arbitrary JSON

beforeAll(async () => {
  db = await createTestDatabase();
  const config = loadConfig({
    DATABASE_URL: TEST_DATABASE_URL,
    CHANNEL_STORE_URL: 'redis://127.0.0.1:6379',
    FACILITATOR_STELLAR_FEE_BUMP_SECRET: Keypair.random().secret(),
    FACILITATOR_STELLAR_CHANNEL_SECRETS: Keypair.random().secret(),
  });
  const persistence = {
    ...createSettlementPersistence(config, log, { db }),
    close: async () => {},
  };
  app = await createApp({
    config,
    engine,
    persistence,
    rateLimits: new MemoryRateLimitStore(),
    log,
  });
  await app.listen(0, '127.0.0.1');
  http = app.getHttpServer();
  doc = (await request(http).get('/docs-json')).body;
});

afterAll(async () => {
  await app.close();
  await db.destroy();
});

describe('OpenAPI document', () => {
  it('lists every public route and no admin route', () => {
    expect(Object.keys(doc.paths).sort()).toEqual([
      '/credentials/keys/current',
      '/credentials/keys/rotate',
      '/credentials/register',
      '/health',
      '/settle',
      '/supported',
      '/verify',
    ]);
  });

  it('points requests at a relative server, so a path prefix in front of the service still works', () => {
    expect(doc.openapi).toMatch(/^3\./);
    expect(doc.servers).toEqual([{ url: './' }]);
  });

  it('reports the version in package.json', () => {
    const { version } = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    );
    expect(doc.info.version).toBe(version);
  });
});

describe('OpenAPI request schemas', () => {
  const schema = (name: string) => doc.components.schemas[name];
  const body = (path: string) =>
    doc.paths[path].post.requestBody.content['application/json'].schema.$ref;

  it('give /verify and /settle the x402 request body, and registration its own', () => {
    expect(body('/verify')).toBe('#/components/schemas/FacilitatorRequestDto');
    expect(body('/settle')).toBe('#/components/schemas/FacilitatorRequestDto');
    expect(body('/credentials/register')).toBe('#/components/schemas/RegisterRequestDto');
  });

  it('describe x402 payment requirements with their types and bounds', () => {
    const requirements = schema('PaymentRequirementsDto');
    expect(requirements.required).toEqual(
      expect.arrayContaining([
        'scheme',
        'network',
        'amount',
        'asset',
        'payTo',
        'maxTimeoutSeconds',
      ]),
    );
    expect(requirements.properties.amount).toMatchObject({ type: 'string', pattern: '^[0-9]+$' });
    expect(requirements.properties.maxTimeoutSeconds).toMatchObject({
      type: 'integer',
      minimum: 1,
      maximum: 300,
    });
    expect(requirements.properties.extra).toMatchObject({
      type: 'object',
      additionalProperties: true,
    });
  });

  it('nest the payload and leave its open x402 objects open', () => {
    const payload = schema('PaymentPayloadDto');
    expect(payload.properties.accepted.$ref).toBe('#/components/schemas/PaymentRequirementsDto');
    for (const open of ['payload', 'resource', 'extensions']) {
      expect(payload.properties[open]).toMatchObject({
        type: 'object',
        additionalProperties: true,
      });
    }
    expect(payload.required).not.toContain('resource');
    expect(schema('FacilitatorRequestDto').properties.paymentPayload.$ref).toBe(
      '#/components/schemas/PaymentPayloadDto',
    );
  });

  it('describe registration fields with their limits', () => {
    const register = schema('RegisterRequestDto');
    expect(register.required).toEqual(expect.arrayContaining(['name', 'domain', 'email']));
    expect(register.properties.name).toMatchObject({
      type: 'string',
      minLength: 1,
      maxLength: 100,
    });
    expect(register.properties.domain).toMatchObject({ type: 'string' });
    expect(register.properties.email).toMatchObject({ type: 'string', maxLength: 254 });
  });
});

describe('OpenAPI responses', () => {
  const ref = (name: string) => `#/components/schemas/${name}`;
  const responses = (path: string, method: string) => doc.paths[path][method].responses;
  const schemaOf = (path: string, method: string, status: number) =>
    responses(path, method)[status]?.content?.['application/json']?.schema?.$ref;
  const ERROR = ref('ErrorBodyDto');

  it.each([
    ['/health', 'get', { 200: ref('HealthResponseDto') }],
    ['/supported', 'get', { 200: ref('SupportedResponseDto'), 401: ERROR, 429: ERROR, 503: ERROR }],
    [
      '/verify',
      'post',
      {
        200: ref('VerifyResponseDto'),
        400: ref('VerifyResponseDto'),
        401: ERROR,
        429: ERROR,
        503: ERROR,
      },
    ],
    [
      '/settle',
      'post',
      {
        200: ref('SettleResponseDto'),
        400: ref('SettleResponseDto'),
        401: ERROR,
        429: ERROR,
        500: ref('SettleResponseDto'),
        503: ERROR,
      },
    ],
    [
      '/credentials/register',
      'post',
      { 201: ref('RegisterResponseDto'), 400: ERROR, 409: ERROR, 429: ERROR },
    ],
    [
      '/credentials/keys/rotate',
      'post',
      { 201: ref('RotateResponseDto'), 401: ERROR, 409: ERROR, 429: ERROR, 503: ERROR },
    ],
  ])('%s %s lists each status with its body', (path, method, expected) => {
    for (const [status, schema] of Object.entries(expected)) {
      expect([status, schemaOf(path, method, Number(status))]).toEqual([status, schema]);
    }
    expect(Object.keys(responses(path, method)).sort()).toEqual(Object.keys(expected).sort());
  });

  it('documents revoking the current key as 204, with its errors', () => {
    expect(Object.keys(responses('/credentials/keys/current', 'delete')).sort()).toEqual([
      '204',
      '401',
      '429',
      '503',
    ]);
  });

  it('declares bearer auth on the key routes only', () => {
    const secured = (path: string, method: string) => Boolean(doc.paths[path][method].security);
    for (const [path, method] of [
      ['/supported', 'get'],
      ['/verify', 'post'],
      ['/settle', 'post'],
      ['/credentials/keys/rotate', 'post'],
      ['/credentials/keys/current', 'delete'],
    ]) {
      expect([path, secured(path!, method!)]).toEqual([path, true]);
    }
    expect(secured('/health', 'get')).toBe(false);
    expect(secured('/credentials/register', 'post')).toBe(false);
  });

  it('describe the x402 response fields', () => {
    const schema = (name: string) => doc.components.schemas[name];
    expect(schema('SettleResponseDto').required).toEqual(
      expect.arrayContaining(['success', 'transaction', 'network']),
    );
    expect(schema('SupportedResponseDto').properties.kinds).toMatchObject({
      type: 'array',
      items: { $ref: ref('SupportedKindDto') },
    });
    expect(schema('ErrorBodyDto').properties.error.$ref).toBe(ref('ErrorDetailDto'));
  });
});

describe('Swagger UI', () => {
  it('sends /docs to /docs/, so relative assets resolve behind a path prefix too', async () => {
    const page = await request(http).get('/docs');
    expect(page.status).toBe(301);
    expect(page.headers.location).toBe('docs/');
  });

  it('serves the page and every asset it references', async () => {
    const page = await request(http).get('/docs/');
    expect(page.status).toBe(200);
    const assets = [...page.text.matchAll(/(?:src|href)="([^"]+)"/g)].map((match) => match[1]!);
    expect(assets.length).toBeGreaterThan(0);
    for (const asset of assets) {
      const url = new URL(asset, 'http://host/docs/').pathname;
      expect([url, (await request(http).get(url)).status]).toEqual([url, 200]);
    }
  });
});
