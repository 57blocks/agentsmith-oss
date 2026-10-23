import { randomBytes } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Keypair } from '@stellar/stellar-sdk';
import type { SettleResponse } from '@x402/core/types';
import { ExactStellarScheme } from '@x402/stellar/exact/facilitator';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/app.js';
import { loadConfig } from '../../src/config/facilitator.config.js';
import { createChannelStoreClient } from '../../src/modules/channels/core/redis-lease-store.js';
import type { Kysely } from 'kysely';
import type { Database } from '../../src/models/database.js';
import {
  createSettlementPersistence,
  type SettlementPersistence,
} from '../../src/modules/x402/services/persistence/settlement-persistence.js';
import { exactPaymentXdr } from '../settlement-fixtures.js';
import { createTestDatabase } from '../test-database.js';
import { TEST_DATABASE_URL } from '../test-env.js';

const url = process.env.CHANNEL_STORE_URL!;
const randomKeypair = () => Keypair.fromRawEd25519Seed(randomBytes(32));
const apps: INestApplication[] = [];
/** One database for every instance in a test, as one deployment shares one. */
let db: Kysely<Database>;

const requirements = {
  scheme: 'exact',
  network: 'stellar:testnet',
  amount: '10000',
  asset: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM',
  payTo: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
  maxTimeoutSeconds: 60,
  extra: { areFeesSponsored: true },
};

const payments = new Map<number, string>();

/** A distinct Buyer payment per `id`, so retry coalescing never merges two of them. */
function body(id: number) {
  if (!payments.has(id)) payments.set(id, exactPaymentXdr());
  const paymentPayload = {
    x402Version: 2,
    accepted: requirements,
    payload: { transaction: payments.get(id) },
  };
  return { x402Version: 2, paymentPayload, paymentRequirements: requirements };
}

async function withStore<T>(
  run: (redis: ReturnType<typeof createChannelStoreClient>) => Promise<T>,
) {
  const redis = createChannelStoreClient(url, { commandTimeoutMs: 1_000, log: console });
  if (redis.status !== 'ready') await new Promise((resolve) => redis.once('ready', resolve));
  try {
    return await run(redis);
  } finally {
    await redis.quit();
  }
}

interface Instance {
  app: INestApplication;
  log: { info: () => void; warn: () => void; error: () => void };
  settle(id: number): Promise<SettleResponse>;
}

/** This instance's view of the shared database; closing the app leaves the database open. */
function sharedPersistence(config: ReturnType<typeof loadConfig>, log: Instance['log']) {
  const persistence: SettlementPersistence = {
    ...createSettlementPersistence(config, log, { db }),
    close: async () => {},
  };
  return persistence;
}

/** One facilitator instance on the shared store, ready once it has seeded. */
async function instance(env: NodeJS.ProcessEnv): Promise<Instance> {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const config = loadConfig(env);
  const app = await createApp({ config, log, persistence: sharedPersistence(config, log) });
  apps.push(app);
  await vi.waitFor(() =>
    expect(log.info).toHaveBeenCalledWith('channel_store_seeded', expect.anything()),
  );
  const server = app.getHttpServer();
  return {
    app,
    log,
    settle: async (id) =>
      (await request(server).post('/settle').send(body(id))).body as SettleResponse,
  };
}

/**
 * Upstream `exact` stubbed after it selects the leased channel: each settlement waits until the test
 * releases it, so leases stay held while other instances settle.
 */
function holdSettlements() {
  const used: string[] = [];
  const pending: ((response: SettleResponse) => void)[] = [];
  vi.spyOn(ExactStellarScheme.prototype, 'settle').mockImplementation(function () {
    const upstream = this as unknown as {
      signingAddresses: ReadonlySet<string>;
      selectSigner(addresses: string[]): string;
    };
    used.push(upstream.selectSigner([...upstream.signingAddresses]));
    return new Promise((resolve) => pending.push(resolve));
  });
  const releaseAll = () => {
    for (const resolve of pending.splice(0)) {
      resolve({ success: true, network: 'stellar:testnet', transaction: 'tx' });
    }
  };
  return { used, releaseAll };
}

function sharedEnv(channels: Keypair[]): NodeJS.ProcessEnv {
  return {
    CHANNEL_STORE_URL: url,
    CHANNEL_ACQUIRE_WAIT_MS: '300',
    DATABASE_URL: TEST_DATABASE_URL,
    FACILITATOR_STELLAR_FEE_BUMP_SECRET: randomKeypair().secret(),
    FACILITATOR_STELLAR_CHANNEL_SECRETS: channels.map((c) => c.secret()).join(','),
  };
}

beforeEach(async () => {
  await withStore((redis) => redis.flushdb());
  db = await createTestDatabase();
  payments.clear();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await db.destroy();
});

describe('two instances sharing one store', () => {
  it('never lease one channel twice, and the third settlement finds the pool full', async () => {
    const channels = [randomKeypair(), randomKeypair()];
    const held = holdSettlements();
    const [a, b] = [await instance(sharedEnv(channels)), await instance(sharedEnv(channels))];

    const first = a.settle(1);
    const second = b.settle(2);
    await vi.waitFor(() => expect(held.used).toHaveLength(2));
    const startedAt = Date.now();
    const third = await a.settle(3);

    expect(new Set(held.used).size).toBe(2);
    expect(third).toMatchObject({
      success: false,
      errorReason: 'settle_exact_stellar_channel_unavailable',
    });
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    held.releaseAll();
    expect((await first).success).toBe(true);
    expect((await second).success).toBe(true);
  });

  it('stop leasing a removed member and lease an added one, without a restart', async () => {
    const channels = [randomKeypair(), randomKeypair()];
    const [kept, removed] = channels.map((c) => c.publicKey());
    const held = holdSettlements();
    const [a, b] = [await instance(sharedEnv(channels)), await instance(sharedEnv(channels))];
    await withStore((redis) => redis.zrem('x402:channels', removed!));

    const first = a.settle(1);
    await vi.waitFor(() => expect(held.used).toEqual([kept]));
    expect((await b.settle(2)).errorReason).toBe('settle_exact_stellar_channel_unavailable');

    await withStore((redis) => redis.zadd('x402:channels', 'NX', 0, removed!));
    const third = b.settle(3);
    await vi.waitFor(() => expect(held.used).toEqual([kept, removed]));
    held.releaseAll();
    await Promise.all([first, third]);
  });
});

describe('rate limits in the shared store', () => {
  it('count requests from every instance together', async () => {
    const channels = [randomKeypair()];
    const env = { ...sharedEnv(channels), RATE_LIMIT_MAX: '2' };
    const [a, b] = [await instance(env), await instance(env)];
    const supported = (target: Instance) => request(target.app.getHttpServer()).get('/supported');

    expect((await supported(a)).status).toBe(200);
    expect((await supported(b)).status).toBe(200);
    expect((await supported(a)).status).toBe(429);
  });
});

describe('a store that cannot be reached', () => {
  it('answers /settle at once without submitting, while /verify and /health keep working', async () => {
    const settle = vi.spyOn(ExactStellarScheme.prototype, 'settle');
    vi.spyOn(ExactStellarScheme.prototype, 'verify').mockResolvedValue({ isValid: true });
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const config = loadConfig({
      ...sharedEnv([randomKeypair()]),
      CHANNEL_STORE_URL: 'redis://127.0.0.1:1/0',
    });
    const app = await createApp({ config, log, persistence: sharedPersistence(config, log) });
    apps.push(app);
    const server = app.getHttpServer();

    const startedAt = Date.now();
    const settled = await request(server).post('/settle').send(body(1));
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(settled.body).toMatchObject({
      success: false,
      errorReason: 'settle_exact_stellar_channel_unavailable',
    });
    expect(settle).not.toHaveBeenCalled();
    expect((await request(server).post('/verify').send(body(2))).body).toEqual({
      isValid: true,
    });
    expect((await request(server).get('/health')).status).toBe(200);
  });
});
