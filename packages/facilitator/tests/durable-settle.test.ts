import { createHash, randomBytes } from 'node:crypto';
import type { FeeBumpTransaction } from '@stellar/stellar-sdk';
import { Keypair, Networks, StrKey, TransactionBuilder } from '@stellar/stellar-sdk';
import type { INestApplication } from '@nestjs/common';
import type { SettleResponse, SupportedResponse, VerifyResponse } from '@x402/core/types';
import { createEd25519Signer } from '@x402/stellar';
import type { Kysely } from 'kysely';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config/facilitator.config.js';
import { SHARED_KEY_RESOURCE_SERVER_ID } from '../src/models/credentials/resource-server.model.js';
import type { Database } from '../src/models/database.js';
import { SettlementRepository } from '../src/modules/x402/repositories/settlement.repository.js';
import type { PaymentEngine } from '../src/modules/x402/services/engine/payment-engine.js';
import { authorizationIdentity } from '../src/modules/x402/services/persistence/authorization-identity.js';
import type { TransactionLookup } from '../src/modules/x402/services/persistence/persisted-settlements.js';
import {
  createSettlementPersistence,
  type SettlementPersistence,
} from '../src/modules/x402/services/persistence/settlement-persistence.js';
import {
  asset,
  exactPaymentXdr,
  payTo,
  unsignedFeeBump,
  uptoPaymentXdr,
} from './settlement-fixtures.js';
import { createTestDatabase } from './test-database.js';
import { TEST_DATABASE_URL } from './test-env.js';
import { ApiCredentialRepository } from '../src/modules/credentials/repositories/api-credential.repository.js';
import { ResourceServerRepository } from '../src/modules/credentials/repositories/resource-server.repository.js';
import { MemoryRateLimitStore } from '../src/common/rate-limit/rate-limit-store.js';

const feePayerKey = Keypair.random();
const channel = Keypair.random();
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const config = loadConfig({
  DATABASE_URL: TEST_DATABASE_URL,
  CHANNEL_STORE_URL: 'redis://127.0.0.1:6379',
  FACILITATOR_STELLAR_FEE_BUMP_SECRET: feePayerKey.secret(),
  FACILITATOR_STELLAR_CHANNEL_SECRETS: channel.secret(),
});

let db: Kysely<Database>;
let now: number;
/** What the RPC node reports: the hash's status and the ledger close times it covers, in seconds. */
let chain: { status: string; latest: number; oldest: number };
let readStatus: ReturnType<typeof vi.fn<(hash: string) => Promise<TransactionLookup>>>;
/** Envelopes the persistence layer sent again, as base64 XDR. */
let resent: string[];
const apps: INestApplication[] = [];

beforeEach(async () => {
  db = await createTestDatabase();
  now = Date.now();
  const nowSeconds = Math.floor(now / 1000);
  chain = { status: 'NOT_FOUND', latest: nowSeconds, oldest: nowSeconds - 86_400 };
  resent = [];
  readStatus = vi.fn(async () => ({
    status: chain.status,
    latestLedgerCloseTime: chain.latest,
    oldestLedgerCloseTime: chain.oldest,
  }));
});

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await db.destroy();
});

type EngineResult = 'success' | 'pending';

/**
 * An engine that signs a real fee-bump through the guarded fee payer and "broadcasts" only an
 * envelope the guard returned, like both schemes do.
 */
function fakeEngine(persistence: SettlementPersistence, result: EngineResult) {
  const feePayer = persistence.journal.guardFinalSigner(
    createEd25519Signer(feePayerKey.secret(), 'stellar:testnet'),
  );
  const broadcast: string[] = [];
  let sequence = 100;
  const engine: PaymentEngine = {
    verify: async () => ({ isValid: true }) as VerifyResponse,
    supported: () =>
      ({
        kinds: [
          { x402Version: 2, scheme: 'exact', network: 'stellar:testnet' },
          { x402Version: 2, scheme: 'upto', network: 'stellar:testnet' },
        ],
        extensions: [],
        signers: {},
      }) as SupportedResponse,
    settle: async (payload, requirements) => {
      // Both schemes verify a zero settlement and answer it, naming the Buyer, without signing.
      if (requirements.amount === '0') {
        const { network } = requirements;
        const payer = authorizationIdentity(payload, requirements)?.payer;
        return { success: true, network, transaction: '', amount: '0', payer };
      }
      const signed = await feePayer.signTransaction(
        unsignedFeeBump(channel, feePayerKey.publicKey(), String(sequence++)),
        { networkPassphrase: Networks.TESTNET },
      );
      const network = requirements.network;
      if (signed.error) {
        const errorReason = 'settle_exact_stellar_fee_bump_signing_failed';
        return { success: false, network, transaction: '', errorReason } as SettleResponse;
      }
      const envelope = TransactionBuilder.fromXDR(signed.signedTxXdr, Networks.TESTNET);
      const transaction = (envelope as FeeBumpTransaction).hash().toString('hex');
      broadcast.push(transaction);
      return result === 'success'
        ? { success: true, network, transaction, amount: requirements.amount }
        : { success: false, network, transaction, errorReason: 'settlement_pending' };
    },
  };
  return { engine, broadcast };
}

async function instance(result: EngineResult = 'success') {
  const persistence = {
    ...createSettlementPersistence(config, log, {
      db,
      readStatus,
      sendTransaction: async (envelopeXdr: string) => {
        resent.push(envelopeXdr);
      },
      now: () => now,
    })!,
    close: async () => {}, // the test owns the shared database
  };
  const { engine, broadcast } = fakeEngine(persistence, result);
  const app = await createApp({
    config,
    engine,
    persistence,
    rateLimits: new MemoryRateLimitStore(),
    log,
  });
  await app.listen(0, '127.0.0.1');
  apps.push(app);
  return { app, broadcast };
}

function body(buyerTransaction: string, amount = '10000') {
  const requirements = {
    scheme: 'exact',
    network: 'stellar:testnet',
    asset,
    payTo,
    amount,
    maxTimeoutSeconds: 60,
    extra: { areFeesSponsored: true },
  };
  return {
    x402Version: 2,
    paymentPayload: {
      x402Version: 2,
      accepted: requirements,
      payload: { transaction: buyerTransaction },
    },
    paymentRequirements: requirements,
  };
}

const kernel = StrKey.encodeContract(randomBytes(32));
const kernelSigner = Keypair.random().publicKey();

/** An `upto` settle of a 10000 maximum; `charge` sets the actual amount and any changed terms. */
function uptoBody(
  buyerTransaction: string,
  charge: { amount?: string; payTo?: string; asset?: string } = {},
) {
  const maximum = {
    scheme: 'upto',
    network: 'stellar:testnet',
    asset,
    payTo,
    amount: '10000',
    maxTimeoutSeconds: 60,
    extra: { areFeesSponsored: true, settlementContract: kernel, facilitator: kernelSigner },
  };
  return {
    x402Version: 2,
    paymentPayload: {
      x402Version: 2,
      accepted: maximum,
      payload: { transaction: buyerTransaction },
    },
    paymentRequirements: { ...maximum, amount: '4000', ...charge },
  };
}

function settle(app: INestApplication, payload: object, key?: string) {
  const call = request(app.getHttpServer()).post('/settle');
  return (key ? call.set('authorization', `Bearer ${key}`) : call).send(payload);
}

/** A key for a new Resource Server, or another key for `resourceServerId`. */
async function keyFor(resourceServerId?: string) {
  const serverId =
    resourceServerId ??
    (
      await new ResourceServerRepository(db).create({
        name: 'Weather API',
        domain: `${randomBytes(4).toString('hex')}.example.com`,
        email: 'dev@example.com',
      })
    ).id;
  const key = `fsk_${randomBytes(32).toString('base64url')}`;
  await new ApiCredentialRepository(db).issue({
    resourceServerId: serverId,
    secretDigest: createHash('sha256').update(key).digest(),
  });
  return { key, serverId };
}

/** A pending row of another payment that holds the channel sequence the engine signs next. */
function holdSequence(validUntil: Date) {
  return new SettlementRepository(db).insertPrepared({
    resourceServerId: SHARED_KEY_RESOURCE_SERVER_ID,
    network: 'stellar:testnet',
    scheme: 'exact',
    asset,
    payTo,
    payer: Keypair.random().publicKey(),
    signatureDigest: randomBytes(32),
    actualAmount: '1',
    feePayerAddress: feePayerKey.publicKey(),
    channelAccountAddress: channel.publicKey(),
    channelAccountSequence: 101n,
    signedXdr: randomBytes(8),
    txHash: randomBytes(32),
    validUntil,
  });
}

describe('durable settlement', () => {
  it('records a settlement, and another instance answers its resend from the database', async () => {
    const payment = body(exactPaymentXdr());
    const first = await instance();
    const second = await instance();

    const original = await settle(first.app, payment);
    expect(original.body).toMatchObject({ success: true });
    expect(first.broadcast).toEqual([original.body.transaction]);

    const resent = await settle(second.app, payment);
    expect(resent.body).toMatchObject({
      success: true,
      transaction: original.body.transaction,
      amount: '10000',
    });
    expect(second.broadcast).toEqual([]);

    const [row] = await db.selectFrom('settlements').selectAll().execute();
    expect(row).toMatchObject({
      status: 'success',
      resourceServerId: SHARED_KEY_RESOURCE_SERVER_ID,
      channelAccountAddress: channel.publicKey(),
      feePayerAddress: feePayerKey.publicKey(),
    });
  });

  it('reconciles a pending settlement by its hash when the settle is resent', async () => {
    const payment = body(exactPaymentXdr());
    const { app, broadcast } = await instance('pending');

    const pending = await settle(app, payment);
    expect(pending.body).toMatchObject({ success: false, errorReason: 'settlement_pending' });

    expect((await settle(app, payment)).body.errorReason).toBe('settlement_pending');
    chain.status = 'SUCCESS';
    const confirmed = await settle(app, payment);

    expect(confirmed.body).toMatchObject({ success: true, transaction: pending.body.transaction });
    expect(readStatus).toHaveBeenLastCalledWith(pending.body.transaction);
    expect(broadcast).toHaveLength(1);
  });

  it('reports a pending settlement as expired once the chain has passed its maxTime', async () => {
    const payment = body(exactPaymentXdr());
    const { app } = await instance('pending');
    await settle(app, payment);

    chain.latest += 10 * 60;
    const expired = await settle(app, payment);

    expect(expired.body).toMatchObject({
      success: false,
      errorReason: 'settlement_expired',
    });
    const [row] = await db.selectFrom('settlements').select('status').execute();
    expect(row?.status).toBe('expired');
    expect((await settle(app, payment)).body.errorReason).toBe('settlement_expired');
  });

  it('reports a pending settlement the chain shows failed as invalid_transaction_state', async () => {
    const payment = body(exactPaymentXdr());
    const { app } = await instance('pending');
    const pending = await settle(app, payment);

    chain.status = 'FAILED';
    const failed = await settle(app, payment);

    const [row] = await db.selectFrom('settlements').select(['status', 'payer']).execute();
    expect(row?.status).toBe('failed');
    expect(failed.body).toEqual({
      success: false,
      errorReason: 'invalid_transaction_state',
      transaction: pending.body.transaction,
      network: 'stellar:testnet',
      payer: row?.payer,
    });
  });

  it('keeps a settlement pending while the chain has not passed its maxTime', async () => {
    const payment = body(exactPaymentXdr());
    const { app } = await instance('pending');
    await settle(app, payment);

    now += 10 * 60_000; // only the local clock moves
    const answer = await settle(app, payment);

    expect(answer.body).toMatchObject({ success: false, errorReason: 'settlement_pending' });
    const [row] = await db.selectFrom('settlements').select('status').execute();
    expect(row?.status).toBe('pending');
  });

  it('keeps a settlement pending when the node no longer holds the history to prove it never landed', async () => {
    const payment = body(exactPaymentXdr());
    const { app } = await instance('pending');
    await settle(app, payment);

    chain.latest += 10 * 60;
    chain.oldest = chain.latest - 60; // pruned: starts after the row was written
    const answer = await settle(app, payment);

    expect(answer.body).toMatchObject({ success: false, errorReason: 'settlement_pending' });
  });

  it('keeps a settlement pending when the node cannot be read', async () => {
    const payment = body(exactPaymentXdr());
    const { app } = await instance('pending');
    await settle(app, payment);

    chain.latest += 10 * 60;
    readStatus.mockRejectedValue(new Error('rpc unavailable'));
    const answer = await settle(app, payment);

    expect(answer.body).toMatchObject({ success: false, errorReason: 'settlement_pending' });
  });

  it('resends the stored envelope unchanged while the transaction can still land', async () => {
    const payment = body(exactPaymentXdr());
    const { app } = await instance('pending');
    await settle(app, payment);
    const [row] = await db.selectFrom('settlements').select('signedXdr').execute();

    // The row's first send time is the database clock, so the backoff is measured from real time.
    now = Date.now() + 3_000;
    const answer = await settle(app, payment);

    expect(answer.body).toMatchObject({ success: false, errorReason: 'settlement_pending' });
    expect(resent).toEqual([Buffer.from(row!.signedXdr).toString('base64')]);
  });

  it('waits out the backoff before sending the envelope again', async () => {
    const payment = body(exactPaymentXdr());
    const { app } = await instance('pending');
    await settle(app, payment);

    now = Date.now() + 3_000;
    await settle(app, payment);
    now += 1_000;
    await settle(app, payment);

    expect(resent).toHaveLength(1);
  });

  it('stops resending once the chain has passed the transaction maxTime', async () => {
    const payment = body(exactPaymentXdr());
    const { app } = await instance('pending');
    await settle(app, payment);

    now += 10 * 60_000;
    chain.latest += 10 * 60;
    await settle(app, payment);

    expect(resent).toEqual([]);
  });

  it('records a settlement under the Resource Server whose key sent it', async () => {
    const { app } = await instance();
    const { key, serverId } = await keyFor();

    await settle(app, body(exactPaymentXdr()), key);

    const [row] = await db.selectFrom('settlements').select('resourceServerId').execute();
    expect(row?.resourceServerId).toBe(serverId);
  });

  it('answers a resend sent with another key of the same Resource Server', async () => {
    const payment = body(exactPaymentXdr());
    const first = await instance();
    const second = await instance();
    const { key, serverId } = await keyFor();
    const original = await settle(first.app, payment, key);

    const resent = await settle(second.app, payment, (await keyFor(serverId)).key);

    expect(resent.body).toMatchObject({ success: true, transaction: original.body.transaction });
    expect(second.broadcast).toEqual([]);
  });

  it('refuses the same authorization from another Resource Server', async () => {
    const payment = body(exactPaymentXdr());
    const first = await instance();
    const second = await instance();
    await settle(first.app, payment, (await keyFor()).key);

    const other = await settle(second.app, payment, (await keyFor()).key);

    expect(other.body).toMatchObject({ success: false, errorReason: 'settlement_amount_conflict' });
    expect(second.broadcast).toEqual([]);
  });

  it('refuses a resend whose terms changed', async () => {
    const buyerTransaction = exactPaymentXdr();
    const first = await instance();
    const second = await instance();
    await settle(first.app, body(buyerTransaction, '10000'));

    const changed = await settle(second.app, body(buyerTransaction, '20000'));

    expect(changed.body).toMatchObject({
      success: false,
      errorReason: 'settlement_amount_conflict',
    });
    expect(second.broadcast).toEqual([]);
  });

  it('refuses an upto resend with another actual amount on the same instance', async () => {
    const buyerTransaction = uptoPaymentXdr(kernel, kernelSigner);
    const { app, broadcast } = await instance();
    const original = await settle(app, uptoBody(buyerTransaction));
    expect(original.body).toMatchObject({ success: true, amount: '4000' });

    const changed = await settle(app, uptoBody(buyerTransaction, { amount: '9000' }));

    expect(changed.body).toMatchObject({
      success: false,
      errorReason: 'settlement_amount_conflict',
    });
    expect(broadcast).toHaveLength(1);
  });

  it('settles only one of two concurrent upto amounts for one authorization', async () => {
    const buyerTransaction = uptoPaymentXdr(kernel, kernelSigner);
    const { app, broadcast } = await instance();

    const responses = await Promise.all([
      settle(app, uptoBody(buyerTransaction, { amount: '4000' })),
      settle(app, uptoBody(buyerTransaction, { amount: '9000' })),
    ]);

    const reasons = responses.map((response) => response.body.errorReason ?? 'success').sort();
    expect(reasons).toEqual(['settlement_amount_conflict', 'success']);
    expect(broadcast).toHaveLength(1);
  });

  it.each([
    { term: 'payTo', change: { payTo: Keypair.random().publicKey() } },
    { term: 'asset', change: { asset: StrKey.encodeContract(randomBytes(32)) } },
  ])('refuses an upto resend whose $term changed on the same instance', async ({ change }) => {
    const buyerTransaction = uptoPaymentXdr(kernel, kernelSigner);
    const { app, broadcast } = await instance();
    await settle(app, uptoBody(buyerTransaction));

    const changed = await settle(app, uptoBody(buyerTransaction, change));

    expect(changed.body).toMatchObject({
      success: false,
      errorReason: 'settlement_amount_conflict',
    });
    expect(broadcast).toHaveLength(1);
  });

  it('answers an identical upto resend with the original settlement', async () => {
    const payment = uptoBody(uptoPaymentXdr(kernel, kernelSigner));
    const { app, broadcast } = await instance();
    const original = await settle(app, payment);

    const resent = await settle(app, payment);

    expect(resent.body).toEqual(original.body);
    expect(broadcast).toHaveLength(1);
  });

  it('takes over a channel sequence whose earlier transaction is proven never to have landed', async () => {
    const { app, broadcast } = await instance();
    const { settlement: stale } = await holdSequence(new Date(now - 60_000));

    const settled = await settle(app, body(exactPaymentXdr()));

    expect(settled.body).toMatchObject({ success: true });
    expect(broadcast).toHaveLength(1);
    const old = await db
      .selectFrom('settlements')
      .select('status')
      .where('id', '=', stale.id)
      .executeTakeFirstOrThrow();
    expect(old.status).toBe('expired');
  });

  it('broadcasts nothing when the settlement cannot be recorded', async () => {
    const { app, broadcast } = await instance();
    // Hold the channel sequence the engine will sign with, so the insert fails.
    await new SettlementRepository(db).insertPrepared({
      resourceServerId: SHARED_KEY_RESOURCE_SERVER_ID,
      network: 'stellar:testnet',
      scheme: 'exact',
      asset,
      payTo,
      payer: Keypair.random().publicKey(),
      signatureDigest: randomBytes(32),
      actualAmount: '1',
      feePayerAddress: feePayerKey.publicKey(),
      channelAccountAddress: channel.publicKey(),
      channelAccountSequence: 101n,
      signedXdr: randomBytes(8),
      txHash: randomBytes(32),
      validUntil: new Date(now + 60_000),
    });

    const failed = await settle(app, body(exactPaymentXdr()));

    expect(failed.status).toBe(500);
    expect(failed.body).toMatchObject({ success: false, errorReason: 'unexpected_settle_error' });
    expect(broadcast).toEqual([]);
  });

  it('rejects a payload whose Buyer authorization it cannot read', async () => {
    const { app, broadcast } = await instance();
    const unreadable = await settle(app, body(Buffer.from('not xdr').toString('base64')));

    expect(unreadable.body).toMatchObject({ success: false, errorReason: 'invalid_payload' });
    expect(broadcast).toEqual([]);
  });

  describe('zero-usage settlement', () => {
    const zeroRows = () =>
      db.selectFrom('settlements').selectAll().where('actualAmount', '=', '0').execute();

    it('records a zero upto settlement as final with no transaction, and sends nothing', async () => {
      const { app, broadcast } = await instance();

      const zero = await settle(
        app,
        uptoBody(uptoPaymentXdr(kernel, kernelSigner), { amount: '0' }),
      );

      const rows = await zeroRows();
      expect(zero.body).toEqual({
        success: true,
        network: 'stellar:testnet',
        transaction: '',
        amount: '0',
        payer: rows[0]?.payer,
      });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        scheme: 'upto',
        status: 'success',
        txHash: null,
        signedXdr: null,
        channelAccountAddress: null,
        feePayerAddress: null,
      });
      expect(rows[0]?.finishedAt).toBeInstanceOf(Date);
      expect(broadcast).toHaveLength(0);
    });

    it('answers an identical zero resend from its row, on another instance', async () => {
      const payment = uptoBody(uptoPaymentXdr(kernel, kernelSigner), { amount: '0' });
      const first = await instance();
      const original = await settle(first.app, payment);
      const second = await instance();

      const resent = await settle(second.app, payment);

      expect(original.body).toMatchObject({ success: true, transaction: '', amount: '0' });
      expect(resent.body).toEqual(original.body);
      expect(await zeroRows()).toHaveLength(1);
    });

    it('refuses to charge an authorization later once it settled for zero', async () => {
      const buyerTransaction = uptoPaymentXdr(kernel, kernelSigner);
      const { app, broadcast } = await instance();
      await settle(app, uptoBody(buyerTransaction, { amount: '0' }));

      const charge = await settle(app, uptoBody(buyerTransaction, { amount: '10000' }));

      expect(charge.body).toEqual({
        success: false,
        errorReason: 'settlement_amount_conflict',
        transaction: '',
        network: 'stellar:testnet',
      });
      expect(broadcast).toHaveLength(0);
    });

    it('refuses zero for an authorization already charged, under its transaction hash', async () => {
      const buyerTransaction = uptoPaymentXdr(kernel, kernelSigner);
      const { app, broadcast } = await instance();
      await settle(app, uptoBody(buyerTransaction, { amount: '4000' }));

      const zero = await settle(app, uptoBody(buyerTransaction, { amount: '0' }));

      expect(zero.body).toEqual({
        success: false,
        errorReason: 'settlement_amount_conflict',
        transaction: broadcast[0],
        network: 'stellar:testnet',
      });
      expect(await zeroRows()).toHaveLength(0);
    });

    it('settles exactly one of a zero and a charge racing on one authorization', async () => {
      const buyerTransaction = uptoPaymentXdr(kernel, kernelSigner);
      const { app, broadcast } = await instance();

      const responses = await Promise.all([
        settle(app, uptoBody(buyerTransaction, { amount: '0' })),
        settle(app, uptoBody(buyerTransaction, { amount: '4000' })),
      ]);

      const succeeded = responses.filter((response) => response.body.success);
      expect(succeeded).toHaveLength(1);
      const rows = await db.selectFrom('settlements').selectAll().execute();
      expect(rows).toHaveLength(1);
      expect(broadcast).toHaveLength(succeeded[0]?.body.amount === '0' ? 0 : 1);
    });

    it('answers 500, never success, when the zero settlement cannot be recorded', async () => {
      vi.spyOn(SettlementRepository.prototype, 'insertZeroUsage').mockRejectedValueOnce(
        new Error('connection reset'),
      );
      const { app } = await instance();

      const zero = await settle(
        app,
        uptoBody(uptoPaymentXdr(kernel, kernelSigner), { amount: '0' }),
      );

      expect(zero.status).toBe(500);
      expect(zero.body.success).not.toBe(true);
      expect(await zeroRows()).toHaveLength(0);
    });

    it('records nothing for a zero exact settlement, whose signed amount cannot change', async () => {
      const { app, broadcast } = await instance();

      const zero = await settle(app, body(exactPaymentXdr(), '0'));

      expect(zero.body).toMatchObject({ success: true, transaction: '', amount: '0' });
      expect(await db.selectFrom('settlements').selectAll().execute()).toHaveLength(0);
      expect(broadcast).toHaveLength(0);
    });
  });
});
