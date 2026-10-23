import { randomBytes } from 'node:crypto';
import type { FeeBumpTransaction } from '@stellar/stellar-sdk';
import {
  Account,
  Asset,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
  rpc,
} from '@stellar/stellar-sdk';
import type { PaymentPayload, PaymentRequirements, SettleResponse } from '@x402/core/types';
import { createEd25519Signer } from '@x402/stellar';
import { ExactStellarScheme } from '@x402/stellar/exact/facilitator';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config/facilitator.config.js';
import {
  createStellarPaymentEngine,
  leaseTtlMs,
} from '../src/modules/x402/services/engine/payment-engine.js';
import type { SettlementContexts } from '../src/modules/x402/services/channels/settlement-context.js';
import { SettlementRepository } from '../src/modules/x402/repositories/settlement.repository.js';
import { SettlementJournal } from '../src/modules/x402/services/persistence/settlement-journal.js';
import { UptoStellarScheme } from '../src/modules/x402/services/schemes/upto/upto-stellar.scheme.js';
import { fakeChannelPool, type FakeChannelPool } from './fake-lease-store.js';
import { exactPaymentXdr } from './settlement-fixtures.js';
import { createTestDatabase } from './test-database.js';
import { journalWithoutDatabase } from './test-journal.js';
import { TEST_DATABASE_URL } from './test-env.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const randomKeypair = () => Keypair.fromRawEd25519Seed(randomBytes(32));
const silent = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() });

type Signer = { signTransaction(xdr: string): Promise<{ signedTxXdr: string }> };

interface Upstream {
  signingAddresses: ReadonlySet<string>;
  selectSigner(addresses: string[]): string;
}

/** Selects the leased channel the way upstream `exact` does, and returns it. */
function selectLeased(upstream: unknown): string {
  const instance = upstream as Upstream;
  return instance.selectSigner([...instance.signingAddresses]);
}

function requirements(scheme = 'exact', maxTimeoutSeconds = 60): PaymentRequirements {
  return {
    scheme,
    network: 'stellar:testnet',
    asset: 'C_TOKEN',
    amount: '40000',
    payTo: 'G_PAYEE',
    maxTimeoutSeconds,
    extra: {},
  } as PaymentRequirements;
}

function payload(terms: PaymentRequirements, id: number): PaymentPayload {
  return { x402Version: 2, accepted: terms, payload: { id } } as PaymentPayload;
}

function settled(transaction: string): SettleResponse {
  return { success: true, network: 'stellar:testnet', transaction };
}

function failed(errorReason: string, transaction = ''): SettleResponse {
  return { success: false, network: 'stellar:testnet', transaction, errorReason };
}

interface Setup extends FakeChannelPool {
  engine: Awaited<ReturnType<typeof createStellarPaymentEngine>>;
  channels: Keypair[];
  feePayer: Keypair;
  log: ReturnType<typeof silent>;
}

/** An engine on an in-memory pool of `count` channels, with `exact` and `upto` enabled. */
async function setup(
  count: number,
  options: { seeded?: number; env?: NodeJS.ProcessEnv; journal?: SettlementJournal } = {},
): Promise<Setup> {
  const channels = Array.from({ length: count }, randomKeypair);
  const feePayer = randomKeypair();
  const config = loadConfig({
    DATABASE_URL: TEST_DATABASE_URL,
    CHANNEL_STORE_URL: 'redis://127.0.0.1:6379',
    FACILITATOR_STELLAR_PRIVATE_KEY: randomKeypair().secret(),
    FACILITATOR_STELLAR_CHANNEL_SECRETS: channels.map((c) => c.secret()).join(','),
    FACILITATOR_STELLAR_FEE_BUMP_SECRET: feePayer.secret(),
    FACILITATOR_API_KEY: 'test-only-token',
    X402_UPTO_KERNEL_CONTRACT: randomKeypair().publicKey(),
    ...options.env,
  });
  const seeded = channels.slice(0, options.seeded ?? count).map((c) => c.publicKey());
  const fake = fakeChannelPool(
    channels.map((c) => c.secret()),
    { seeded },
  );
  const log = silent();
  const engine = await createStellarPaymentEngine(config, log, {
    pool: fake.pool,
    clock: fake.clock,
    journal: options.journal ?? journalWithoutDatabase(),
  });
  return { ...fake, engine, channels, feePayer, log };
}

/** Milliseconds until the lease on `address` ends, by the fake store's clock. */
function heldForMs({ store, clock }: FakeChannelPool, address: string): number {
  const lease = store.leases.get(address);
  return lease ? Math.max(0, lease.expiresAt - clock.now()) : 0;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('payment engine on the shared channel pool', () => {
  it('advertises only the upto authorization key as signer', async () => {
    const { engine } = await setup(2);
    const supported = engine.supported();
    const upto = supported.kinds.find((kind) => kind.scheme === 'upto');

    expect(supported.kinds.map((kind) => kind.scheme).sort()).toEqual(['exact', 'upto']);
    expect(supported.signers['stellar:*']).toEqual([upto?.extra?.facilitator]);
  });

  it('advertises no signer when upto is not enabled', async () => {
    const { engine } = await setup(2, { env: { X402_UPTO_KERNEL_CONTRACT: '' } });

    expect(engine.supported().signers['stellar:*']).toEqual([]);
  });

  it('rejects an exact payment carrying preconditions without leasing or settling', async () => {
    const upstream = vi.spyOn(ExactStellarScheme.prototype, 'settle');
    const fake = await setup(2);
    const acquire = vi.spyOn(fake.store, 'tryAcquire');
    const terms = requirements('exact');
    const transaction = exactPaymentXdr({}, { minAccountSequence: '7' });

    const result = await fake.engine.settle(
      { x402Version: 2, accepted: terms, payload: { transaction } } as PaymentPayload,
      terms,
    );

    expect(result).toMatchObject({
      success: false,
      transaction: '',
      errorReason: 'invalid_exact_stellar_payload_preconditions',
    });
    expect(acquire).not.toHaveBeenCalled();
    expect(upstream).not.toHaveBeenCalled();
    expect(fake.store.leases.size).toBe(0);
  });

  it('leases different channels to concurrent exact and upto settlements', async () => {
    const exactDone = deferred<SettleResponse>();
    const uptoDone = deferred<SettleResponse>();
    const selected: string[] = [];
    vi.spyOn(ExactStellarScheme.prototype, 'settle').mockImplementation(function () {
      selected.push(selectLeased(this));
      return exactDone.promise;
    });
    vi.spyOn(UptoStellarScheme.prototype, 'settle').mockImplementation(async function () {
      const context = (this as unknown as { contexts: SettlementContexts }).contexts.get();
      selected.push((await context.acquire()).address);
      context.selectedForSigning = true;
      return uptoDone.promise;
    });
    const { engine } = await setup(2);

    const exact = engine.settle(payload(requirements('exact'), 1), requirements('exact'));
    await vi.waitFor(() => expect(selected).toHaveLength(1));
    const upto = engine.settle(payload(requirements('upto'), 2), requirements('upto'));
    await vi.waitFor(() => expect(selected).toHaveLength(2));
    expect(selected[0]).not.toBe(selected[1]);

    const third = await engine.settle(payload(requirements('exact'), 3), requirements('exact'));
    expect(third.errorReason).toBe('settle_exact_stellar_channel_unavailable');
    exactDone.resolve(settled('tx-exact'));
    uptoDone.resolve(settled('tx-upto'));
    expect((await exact).success).toBe(true);
    expect((await upto).success).toBe(true);
  });

  it('cools an included settlement channel down, then leases it again', async () => {
    vi.spyOn(ExactStellarScheme.prototype, 'settle').mockImplementation(async function () {
      selectLeased(this);
      return settled('tx-hash');
    });
    const pool = await setup(1);
    const terms = requirements();

    expect((await pool.engine.settle(payload(terms, 1), terms)).success).toBe(true);
    expect(heldForMs(pool, pool.channels[0]!.publicKey())).toBe(6_000);
    expect((await pool.engine.settle(payload(terms, 2), terms)).errorReason).toBe(
      'settle_exact_stellar_channel_unavailable',
    );
    pool.clock.current += 6_000;
    expect((await pool.engine.settle(payload(terms, 3), terms)).success).toBe(true);
  });

  it('releases the channel at once when verification fails before selection', async () => {
    vi.spyOn(ExactStellarScheme.prototype, 'settle').mockResolvedValue(
      failed('invalid_exact_stellar_payload_wrong_amount'),
    );
    const pool = await setup(1);
    const terms = requirements();

    await pool.engine.settle(payload(terms, 1), terms);
    expect(heldForMs(pool, pool.channels[0]!.publicKey())).toBe(0);
  });

  it.each([
    ['settle_exact_stellar_transaction_signing_failed', 'settlement_signing_failed'],
    ['settle_exact_stellar_fee_bump_signing_failed', 'settlement_signing_failed'],
  ])('releases the channel at once after %s and logs %s', async (errorReason, event) => {
    vi.spyOn(ExactStellarScheme.prototype, 'settle').mockImplementation(async function () {
      selectLeased(this);
      return failed(errorReason);
    });
    const pool = await setup(1);
    const terms = requirements();

    expect((await pool.engine.settle(payload(terms, 1), terms)).errorReason).toBe(errorReason);
    expect(heldForMs(pool, pool.channels[0]!.publicKey())).toBe(0);
    expect(pool.log.warn).toHaveBeenCalledWith(event, {
      channel: pool.channels[0]!.publicKey(),
      errorReason,
    });
  });

  it.each([
    ['settle_upto_signing_failed', 'settlement_signing_failed'],
    ['settle_upto_transaction_build_failed', 'settlement_build_failed'],
  ])('releases an upto channel at once after %s and logs %s', async (errorReason, event) => {
    vi.spyOn(UptoStellarScheme.prototype, 'settle').mockImplementation(async function () {
      const context = (this as unknown as { contexts: SettlementContexts }).contexts.get();
      await context.acquire();
      context.outcome = { kind: 'not-sent' };
      return failed(errorReason);
    });
    const pool = await setup(1);
    const terms = requirements('upto');

    expect((await pool.engine.settle(payload(terms, 1), terms)).errorReason).toBe(errorReason);
    expect(heldForMs(pool, pool.channels[0]!.publicKey())).toBe(0);
    expect(pool.log.warn).toHaveBeenCalledWith(event, {
      channel: pool.channels[0]!.publicKey(),
      errorReason,
    });
  });

  it('keeps a refused channel, without retrying, while its stored envelope can still land', async () => {
    const used: string[] = [];
    vi.spyOn(ExactStellarScheme.prototype, 'settle').mockImplementation(async function () {
      used.push(selectLeased(this));
      return failed('settle_exact_stellar_transaction_submission_failed');
    });
    const pool = await setup(2);
    const terms = requirements();

    await pool.engine.settle(payload(terms, 1), terms);

    expect(used).toHaveLength(1);
    // The stored envelope is resent until it expires, so its sequence stays reserved.
    expect(heldForMs(pool, used[0]!)).toBe(60_000 + 30_000);
  });

  it('holds a channel whose outcome is unknown until its transaction can no longer be included', async () => {
    vi.spyOn(ExactStellarScheme.prototype, 'settle').mockImplementation(async function () {
      selectLeased(this);
      return failed('unexpected_settle_error');
    });
    const pool = await setup(1);
    const terms = requirements('exact', 60);

    expect((await pool.engine.settle(payload(terms, 1), terms)).errorReason).toBe(
      'settlement_pending_unknown',
    );
    expect(heldForMs(pool, pool.channels[0]!.publicKey())).toBe(60_000 + 30_000);
  });

  it.each([
    ['exact', 'settle_exact_stellar_channel_unavailable'],
    ['upto', 'settle_upto_channel_unavailable'],
  ])('answers %s with %s at once when the store is down', async (scheme, errorReason) => {
    const exact = vi.spyOn(ExactStellarScheme.prototype, 'settle');
    vi.spyOn(UptoStellarScheme.prototype, 'settle').mockImplementation(async function () {
      await (this as unknown as { contexts: SettlementContexts }).contexts.get().acquire();
      return settled('never');
    });
    const pool = await setup(1);
    pool.store.available = false;
    const terms = requirements(scheme);
    const startedAt = pool.clock.now();

    expect((await pool.engine.settle(payload(terms, 1), terms)).errorReason).toBe(errorReason);
    expect(pool.clock.now()).toBe(startedAt);
    expect(exact).not.toHaveBeenCalled();
    expect(pool.log.warn).toHaveBeenCalledWith('settlement_channel_store_unavailable', {
      scheme,
      network: 'stellar:testnet',
    });
  });

  it('answers pool-full before any lease without settling, and still verifies', async () => {
    const settle = vi.spyOn(ExactStellarScheme.prototype, 'settle');
    const verify = vi
      .spyOn(ExactStellarScheme.prototype, 'verify')
      .mockResolvedValue({ isValid: true });
    const pool = await setup(1);
    // Another instance holds the only channel, so this engine has never leased one.
    pool.store.leases.set(pool.channels[0]!.publicKey(), {
      token: 'other-instance',
      expiresAt: pool.clock.now() + 60_000,
    });
    const terms = requirements();

    expect((await pool.engine.settle(payload(terms, 1), terms)).errorReason).toBe(
      'settle_exact_stellar_channel_unavailable',
    );
    expect(settle).not.toHaveBeenCalled();
    expect(await pool.engine.verify(payload(terms, 2), terms)).toEqual({ isValid: true });
    expect(verify).toHaveBeenCalledOnce();
  });

  it('logs the pool as exhausted when no channel frees up within the wait', async () => {
    const done = deferred<SettleResponse>();
    vi.spyOn(ExactStellarScheme.prototype, 'settle').mockImplementation(function () {
      selectLeased(this);
      return done.promise;
    });
    const pool = await setup(1);
    const terms = requirements();

    const first = pool.engine.settle(payload(terms, 1), terms);
    await vi.waitFor(() => expect(pool.store.isLeased(pool.channels[0]!.publicKey())).toBe(true));
    await pool.engine.settle(payload(terms, 2), terms);

    expect(pool.log.warn).toHaveBeenCalledWith('channel_pool_exhausted', {
      scheme: 'exact',
      network: 'stellar:testnet',
      waitMs: 3_000,
    });
    done.resolve(settled('tx'));
    await first;
  });

  it('settles exact on a channel added to the store after startup', async () => {
    const done = deferred<SettleResponse>();
    const used: string[] = [];
    vi.spyOn(ExactStellarScheme.prototype, 'settle').mockImplementation(function () {
      used.push(selectLeased(this));
      return used.length === 1 ? done.promise : Promise.resolve(settled('tx-added'));
    });
    const pool = await setup(2, { seeded: 1 });
    const terms = requirements();
    const first = pool.engine.settle(payload(terms, 1), terms);
    await vi.waitFor(() => expect(used).toHaveLength(1));

    const added = pool.channels[1]!.publicKey();
    pool.store.scores.set(added, 0);
    const result = await pool.engine.settle(payload(terms, 2), terms);

    expect(result).toMatchObject({ success: true, transaction: 'tx-added' });
    expect(used[1]).toBe(added);
    done.resolve(settled('tx-first'));
    await first;
  });
});

describe('payment engine fee payer', () => {
  /** A minimum-bid fee-bump around a channel-signed transaction, as both schemes first build it. */
  function minimumFeeBump(feePayer: string): string {
    const channel = randomKeypair();
    const inner = new TransactionBuilder(new Account(channel.publicKey(), '1'), {
      fee: '100',
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(
        Operation.payment({
          destination: randomKeypair().publicKey(),
          asset: Asset.native(),
          amount: '1',
        }),
      )
      .setTimeout(60)
      .build();
    inner.sign(channel);
    return TransactionBuilder.buildFeeBumpTransaction(
      feePayer,
      '100',
      inner,
      Networks.TESTNET,
    ).toXDR();
  }

  // The settlement journal's guard wraps the priced fee payer.
  it.each([
    ['exact', ExactStellarScheme.prototype],
    ['upto', UptoStellarScheme.prototype],
  ] as const)(
    'prices each fee-bump that %s has its fee payer sign, through the journal',
    async (scheme, prototype) => {
      const getFeeStats = vi
        .spyOn(rpc.Server.prototype, 'getFeeStats')
        .mockResolvedValue({ sorobanInclusionFee: { p50: '200' } } as rpc.Api.GetFeeStatsResponse);
      let signed: FeeBumpTransaction | undefined;
      vi.spyOn(prototype, 'verify').mockImplementation(async function (this: unknown) {
        const { feeBumpSigner } = this as { feeBumpSigner: { address: string } & Signer };
        const result = await feeBumpSigner.signTransaction(minimumFeeBump(feeBumpSigner.address));
        signed = TransactionBuilder.fromXDR(
          result.signedTxXdr,
          Networks.TESTNET,
        ) as FeeBumpTransaction;
        return { isValid: true };
      });
      const db = await createTestDatabase();
      const journal = new SettlementJournal(
        new SettlementRepository(db),
        Networks.TESTNET,
        silent(),
      );
      const { engine, feePayer } = await setup(1, { journal });
      const terms = requirements(scheme);

      await engine.verify(payload(terms, 1), terms);
      await db.destroy();

      // The first signing reads the median, 200, and bids 1.5 times it: two operations at 300.
      expect(signed?.feeSource).toBe(feePayer.publicKey());
      expect(signed?.fee).toBe('600');
      expect(getFeeStats).toHaveBeenCalledOnce();
    },
    // Each case builds a database, whose first PGlite load is slow on CI runners.
    15_000,
  );

  // Engines in these tests call the schemes directly, outside `journal.run`, where a real guard
  // would pass a signature through; the test journal refuses it instead.
  it('cannot be signed through the test journal, so a test engine broadcasts nothing', async () => {
    const feePayer = randomKeypair();
    const guarded = journalWithoutDatabase().guardFinalSigner(
      createEd25519Signer(feePayer.secret(), 'stellar:testnet'),
    );

    expect(await guarded.signTransaction(minimumFeeBump(feePayer.publicKey()))).toEqual({
      signedTxXdr: '',
      error: { message: 'the test journal refuses the fee payer signature', code: -1 },
    });
  });
});

describe('payment engine verification', () => {
  it.each([
    ['exact', ExactStellarScheme.prototype, UptoStellarScheme.prototype],
    ['upto', UptoStellarScheme.prototype, ExactStellarScheme.prototype],
  ] as const)('sends %s verification only to that scheme', async (scheme, chosen, other) => {
    const verify = vi
      .spyOn(chosen, 'verify')
      .mockResolvedValue({ isValid: true, payer: 'G_BUYER' });
    const otherVerify = vi.spyOn(other, 'verify');
    const { engine } = await setup(1);
    const terms = requirements(scheme);

    expect(await engine.verify(payload(terms, 1), terms)).toEqual({
      isValid: true,
      payer: 'G_BUYER',
    });
    expect(verify).toHaveBeenCalledOnce();
    expect(verify.mock.calls[0]!.slice(0, 2)).toEqual([payload(terms, 1), terms]);
    expect(otherVerify).not.toHaveBeenCalled();
  });

  it('logs a valid verification with its network, scheme and payer', async () => {
    vi.spyOn(ExactStellarScheme.prototype, 'verify').mockResolvedValue({
      isValid: true,
      payer: 'G_BUYER',
    });
    const { engine, log } = await setup(1);
    const terms = requirements();

    await engine.verify(payload(terms, 1), terms);

    expect(log.info).toHaveBeenCalledWith('payment_verified', {
      network: 'stellar:testnet',
      scheme: 'exact',
      valid: true,
      payer: 'G_BUYER',
    });
  });

  it('logs a rejected verification with its reason and message, not as a verify failure', async () => {
    vi.spyOn(ExactStellarScheme.prototype, 'verify').mockResolvedValue({
      isValid: false,
      invalidReason: 'invalid_exact_stellar_payload_fee_exceeds_maximum',
      invalidMessage: 'simulation-derived fee 40001 stroops exceeds ceiling 40000 stroops',
      payer: 'G_BUYER',
    });
    const { engine, log } = await setup(1);
    const terms = requirements();

    await engine.verify(payload(terms, 1), terms);

    expect(log.info).toHaveBeenCalledWith('payment_verified', {
      network: 'stellar:testnet',
      scheme: 'exact',
      valid: false,
      invalidReason: 'invalid_exact_stellar_payload_fee_exceeds_maximum',
      invalidMessage: 'simulation-derived fee 40001 stroops exceeds ceiling 40000 stroops',
      payer: 'G_BUYER',
    });
    expect(log.warn).not.toHaveBeenCalledWith('payment_verify_failed', expect.anything());
  });

  it('logs a verification the scheme could not complete as a failure at warn', async () => {
    vi.spyOn(UptoStellarScheme.prototype, 'verify').mockResolvedValue({
      isValid: false,
      invalidReason: 'unexpected_verify_error',
      payer: 'G_BUYER',
    });
    const { engine, log } = await setup(1);
    const terms = requirements('upto');

    expect(await engine.verify(payload(terms, 1), terms)).toEqual({
      isValid: false,
      invalidReason: 'unexpected_verify_error',
      payer: 'G_BUYER',
    });
    expect(log.warn).toHaveBeenCalledWith('payment_verify_failed', {
      network: 'stellar:testnet',
      scheme: 'upto',
      invalidReason: 'unexpected_verify_error',
    });
    expect(log.info).not.toHaveBeenCalledWith('payment_verified', expect.anything());
  });

  it('logs a verification that throws by error name only', async () => {
    vi.spyOn(ExactStellarScheme.prototype, 'verify').mockRejectedValue(
      new TypeError('RPC https://secret.internal account S_NOT_A_KEY'),
    );
    const { engine, log } = await setup(1);
    const terms = requirements();

    await expect(engine.verify(payload(terms, 1), terms)).rejects.toThrow(TypeError);
    const failures = log.warn.mock.calls.filter(([event]) => event === 'payment_verify_failed');
    expect(failures).toEqual([
      [
        'payment_verify_failed',
        { network: 'stellar:testnet', scheme: 'exact', errorName: 'TypeError' },
      ],
    ]);
    expect(log.info).not.toHaveBeenCalledWith('payment_verified', expect.anything());
  });
});

describe('settlement log', () => {
  function completed(log: Setup['log']) {
    const calls = log.info.mock.calls.filter(([event]) => event === 'settlement_completed');
    expect(calls).toHaveLength(1);
    return calls[0]![1];
  }

  it('logs a settled payment with its channel, hash and acquire wait', async () => {
    vi.spyOn(ExactStellarScheme.prototype, 'settle').mockImplementation(async function () {
      selectLeased(this);
      return settled('tx-hash');
    });
    const pool = await setup(1);
    const terms = requirements();

    await pool.engine.settle(payload(terms, 1), terms);

    expect(completed(pool.log)).toEqual({
      network: 'stellar:testnet',
      scheme: 'exact',
      channel: pool.channels[0]!.publicKey(),
      result: 'settled',
      errorReason: undefined,
      errorName: undefined,
      txHash: 'tx-hash',
      acquireWaitMs: 0,
    });
  });

  it('logs a pool-full refusal with the time spent waiting and no channel', async () => {
    const done = deferred<SettleResponse>();
    vi.spyOn(ExactStellarScheme.prototype, 'settle').mockImplementation(function () {
      selectLeased(this);
      return done.promise;
    });
    const pool = await setup(1);
    const terms = requirements();
    const first = pool.engine.settle(payload(terms, 1), terms);
    await vi.waitFor(() => expect(pool.store.isLeased(pool.channels[0]!.publicKey())).toBe(true));

    await pool.engine.settle(payload(terms, 2), terms);

    expect(completed(pool.log)).toMatchObject({
      channel: undefined,
      result: 'channel_unavailable',
      errorReason: 'settle_exact_stellar_channel_unavailable',
      acquireWaitMs: expect.any(Number),
    });
    expect(completed(pool.log).acquireWaitMs).toBeGreaterThanOrEqual(3_000);
    done.resolve(settled('tx'));
    await first;
  });

  it('logs a failure before broadcast as failed, with its reason', async () => {
    vi.spyOn(ExactStellarScheme.prototype, 'settle').mockImplementation(async function () {
      selectLeased(this);
      return failed('settle_exact_stellar_transaction_signing_failed');
    });
    const pool = await setup(1);
    const terms = requirements();

    await pool.engine.settle(payload(terms, 1), terms);

    expect(completed(pool.log)).toMatchObject({
      result: 'failed',
      errorReason: 'settle_exact_stellar_transaction_signing_failed',
      txHash: undefined,
    });
  });

  it('logs an unknown outcome as pending', async () => {
    vi.spyOn(ExactStellarScheme.prototype, 'settle').mockImplementation(async function () {
      selectLeased(this);
      return failed('unexpected_settle_error');
    });
    const pool = await setup(1);
    const terms = requirements();

    await pool.engine.settle(payload(terms, 1), terms);

    expect(completed(pool.log)).toMatchObject({
      result: 'pending',
      errorReason: 'settlement_pending_unknown',
    });
  });

  it('logs a settlement that throws as error, then rethrows', async () => {
    vi.spyOn(ExactStellarScheme.prototype, 'settle').mockRejectedValue(new TypeError('boom'));
    const pool = await setup(1);
    const terms = requirements();

    await expect(pool.engine.settle(payload(terms, 1), terms)).rejects.toThrow('boom');

    expect(completed(pool.log)).toMatchObject({ result: 'error', errorName: 'TypeError' });
  });
});

describe('lease TTL', () => {
  it('covers verification, the poll loop with its overhead, and a margin', () => {
    const pool = loadConfig({
      DATABASE_URL: TEST_DATABASE_URL,
      CHANNEL_STORE_URL: 'redis://127.0.0.1:6379',
      FACILITATOR_STELLAR_CHANNEL_SECRETS: randomKeypair().secret(),
      FACILITATOR_STELLAR_FEE_BUMP_SECRET: randomKeypair().secret(),
      FACILITATOR_API_KEY: 'test-only-token',
    }).channelPool;

    expect(leaseTtlMs(300, pool)).toBe(495_000);
  });
});
