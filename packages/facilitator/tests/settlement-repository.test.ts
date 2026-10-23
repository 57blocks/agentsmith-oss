import { createHash, randomBytes } from 'node:crypto';
import type { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SHARED_KEY_RESOURCE_SERVER_ID } from '../src/models/credentials/resource-server.model.js';
import type { Database } from '../src/models/database.js';
import {
  SettlementRepository,
  type PreparedSettlement,
  type ZeroUsageSettlement,
} from '../src/modules/x402/repositories/settlement.repository.js';
import { createTestDatabase } from './test-database.js';

let db: Kysely<Database>;
let settlements: SettlementRepository;

beforeEach(async () => {
  db = await createTestDatabase();
  settlements = new SettlementRepository(db);
});

afterEach(async () => {
  await db.destroy();
});

const digest = () => createHash('sha256').update(randomBytes(16)).digest();

function prepared(overrides: Partial<PreparedSettlement> = {}): PreparedSettlement {
  return {
    resourceServerId: SHARED_KEY_RESOURCE_SERVER_ID,
    network: 'stellar:testnet',
    scheme: 'exact',
    asset: 'C_USDC',
    payTo: 'G_PAY_TO',
    payer: 'G_PAYER',
    signatureDigest: digest(),
    actualAmount: '40000',
    feePayerAddress: 'G_FEE_PAYER',
    channelAccountAddress: 'G_CHANNEL_A',
    channelAccountSequence: 1000n,
    signedXdr: randomBytes(64),
    txHash: digest(),
    validUntil: new Date(Date.now() + 60_000),
    ...overrides,
  };
}

describe('SettlementRepository.insertPrepared', () => {
  it('stores a signed settlement as pending, stamped as handed to submission', async () => {
    const input = prepared({ channelAccountSequence: 9_007_199_254_740_993n });
    const { settlement, inserted } = await settlements.insertPrepared(input);

    expect(inserted).toBe(true);
    expect(settlement).toMatchObject({ status: 'pending', finishedAt: null, feeCharged: null });
    expect(settlement.sendTxAt).toBeInstanceOf(Date);
    expect(settlement.channelAccountSequence).toBe(9_007_199_254_740_993n);
    expect(await settlements.findBySignatureDigest(input.signatureDigest)).toEqual(settlement);
  });

  it('returns the first row, not a new one, when the authorization is recorded again', async () => {
    const input = prepared();
    const first = await settlements.insertPrepared(input);
    const second = await settlements.insertPrepared({
      ...input,
      channelAccountAddress: 'G_CHANNEL_B',
      txHash: digest(),
    });

    expect(second).toEqual({ settlement: first.settlement, inserted: false });
  });

  it('stores amounts beyond 2^53 exactly and rejects a negative or fractional amount', async () => {
    const i128Max = '170141183460469231731687303715884105727';
    expect(
      (await settlements.insertPrepared(prepared({ actualAmount: i128Max }))).settlement
        .actualAmount,
    ).toBe(i128Max);
    await expect(settlements.insertPrepared(prepared({ actualAmount: '-1' }))).rejects.toThrow();
    await expect(settlements.insertPrepared(prepared({ actualAmount: '1.5' }))).rejects.toThrow();
  });

  it('never lets two pending settlements hold the same channel sequence', async () => {
    const sameSequence = { channelAccountAddress: 'G_CHANNEL', channelAccountSequence: 77n };
    const first = prepared(sameSequence);
    await settlements.insertPrepared(first);

    await expect(settlements.insertPrepared(prepared(sameSequence))).rejects.toThrow();

    await settlements.finish(
      (await settlements.findBySignatureDigest(first.signatureDigest))!.id,
      first.txHash,
      'expired',
    );
    expect((await settlements.insertPrepared(prepared(sameSequence))).inserted).toBe(true);
  });

  it('attributes settlements to the shared-key Resource Server seeded by the migrations', async () => {
    const { settlement } = await settlements.insertPrepared(prepared());
    expect(settlement.resourceServerId).toBe(SHARED_KEY_RESOURCE_SERVER_ID);
  });
});

describe('SettlementRepository.finish', () => {
  it('records a final outcome once, with the time and the confirmed fee', async () => {
    const input = prepared();
    const { settlement } = await settlements.insertPrepared(input);

    expect(await settlements.finish(settlement.id, digest(), 'success')).toBe(false);
    expect(await settlements.finish(settlement.id, input.txHash, 'success', '125')).toBe(true);
    expect(await settlements.finish(settlement.id, input.txHash, 'failed')).toBe(false);

    const stored = await settlements.findBySignatureDigest(input.signatureDigest);
    expect(stored).toMatchObject({ status: 'success', feeCharged: '125' });
    expect(stored?.finishedAt).toBeInstanceOf(Date);
  });
});

function zeroUsage(overrides: Partial<ZeroUsageSettlement> = {}): ZeroUsageSettlement {
  return {
    resourceServerId: SHARED_KEY_RESOURCE_SERVER_ID,
    network: 'stellar:testnet',
    scheme: 'upto',
    asset: 'C_USDC',
    payTo: 'G_PAY_TO',
    payer: 'G_PAYER',
    signatureDigest: digest(),
    actualAmount: '0',
    ...overrides,
  };
}

describe('SettlementRepository.insertZeroUsage', () => {
  it('stores a zero upto settlement as final success with no transaction', async () => {
    const input = zeroUsage();

    const { settlement, inserted } = await settlements.insertZeroUsage(input);

    expect(inserted).toBe(true);
    expect(settlement).toMatchObject({
      status: 'success',
      actualAmount: '0',
      feePayerAddress: null,
      channelAccountAddress: null,
      channelAccountSequence: null,
      signedXdr: null,
      txHash: null,
      validUntil: null,
      sendTxAt: null,
    });
    expect(settlement.finishedAt).toBeInstanceOf(Date);
  });

  it('returns the first row when the authorization is already recorded, by either path', async () => {
    const charged = prepared({ scheme: 'upto' });
    await settlements.insertPrepared(charged);

    const { settlement, inserted } = await settlements.insertZeroUsage(
      zeroUsage({ signatureDigest: charged.signatureDigest }),
    );

    expect(inserted).toBe(false);
    expect(settlement).toMatchObject({ status: 'pending', actualAmount: '40000' });
  });

  it.each([
    ['an exact settlement', { scheme: 'exact' as const }],
    ['a non-zero amount', { actualAmount: '1' }],
  ])('refuses %s without a transaction', async (_, change) => {
    await expect(settlements.insertZeroUsage(zeroUsage(change))).rejects.toThrow(
      /settlements_transaction_or_zero_usage/,
    );
  });
});

describe('the transaction-or-zero-usage constraint', () => {
  it('refuses a pending row without a transaction', async () => {
    await expect(
      db
        .insertInto('settlements')
        .values({ ...zeroUsage(), status: 'pending' })
        .execute(),
    ).rejects.toThrow(/settlements_transaction_or_zero_usage/);
  });

  it('refuses a row with only some transaction columns', async () => {
    const { txHash: _txHash, ...partial } = prepared({ scheme: 'upto', actualAmount: '0' });

    await expect(
      db
        .insertInto('settlements')
        .values({ ...partial, status: 'success', finishedAt: new Date() })
        .execute(),
    ).rejects.toThrow(/settlements_transaction_or_zero_usage/);
  });

  it('still stores a transaction row for a zero amount', async () => {
    const { inserted } = await settlements.insertPrepared(prepared({ actualAmount: '0' }));

    expect(inserted).toBe(true);
  });
});
