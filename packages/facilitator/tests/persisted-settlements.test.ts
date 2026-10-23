import { createHash, randomBytes } from 'node:crypto';
import type { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SHARED_KEY_RESOURCE_SERVER_ID } from '../src/models/credentials/resource-server.model.js';
import type { Database } from '../src/models/database.js';
import { SettlementRepository } from '../src/modules/x402/repositories/settlement.repository.js';
import { PersistedSettlements } from '../src/modules/x402/services/persistence/persisted-settlements.js';
import type { SettlementDraft } from '../src/modules/x402/services/persistence/settlement-journal.js';
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

const draft: SettlementDraft = {
  resourceServerId: SHARED_KEY_RESOURCE_SERVER_ID,
  network: 'stellar:testnet',
  scheme: 'exact',
  asset: 'C_USDC',
  payTo: 'G_PAY_TO',
  payer: 'G_PAYER',
  signatureDigest: createHash('sha256').update(randomBytes(16)).digest(),
  actualAmount: '40000',
};

describe('PersistedSettlements.answer', () => {
  it('answers what another writer stored when it loses the race to finish the row', async () => {
    const { settlement: stale } = await settlements.insertPrepared({
      ...draft,
      feePayerAddress: 'G_FEE_PAYER',
      channelAccountAddress: 'G_CHANNEL',
      channelAccountSequence: 7n,
      signedXdr: randomBytes(64),
      txHash: randomBytes(32),
      validUntil: new Date(Date.now() - 60_000),
    });
    await settlements.finish(stale.id, stale.txHash, 'success');
    const nowSeconds = Math.floor(Date.now() / 1000);
    const provesExpiry = async () => ({
      status: 'NOT_FOUND',
      latestLedgerCloseTime: nowSeconds,
      oldestLedgerCloseTime: nowSeconds - 86_400,
    });

    const records = new PersistedSettlements({
      settlements,
      readStatus: provesExpiry,
      sendTransaction: async () => {},
      log: { info() {}, warn() {}, error() {} },
      historySkewMs: 60_000,
    });
    const answer = await records.answer(stale, draft);

    expect(answer).toMatchObject({ success: true, amount: '40000' });
  });
});

describe('PersistedSettlements.recordEngineResult', () => {
  const records = () =>
    new PersistedSettlements({
      settlements,
      readStatus: async () => {
        throw new Error('recording an engine result reads nothing');
      },
      sendTransaction: async () => {},
      log: { info() {}, warn() {}, error() {} },
      historySkewMs: 60_000,
    });

  async function pending() {
    const { settlement } = await settlements.insertPrepared({
      ...draft,
      signatureDigest: createHash('sha256').update(randomBytes(16)).digest(),
      feePayerAddress: 'G_FEE_PAYER',
      channelAccountAddress: 'G_CHANNEL',
      channelAccountSequence: 7n,
      signedXdr: randomBytes(64),
      txHash: randomBytes(32),
      validUntil: new Date(Date.now() + 60_000),
    });
    return settlement;
  }

  const hashOf = (row: { txHash: Uint8Array | null }) => Buffer.from(row.txHash!).toString('hex');

  const statusOf = async (row: { signatureDigest: Uint8Array }) =>
    (await settlements.findBySignatureDigest(Buffer.from(row.signatureDigest)))?.status;

  const result = (transaction: string, errorReason?: string) => ({
    success: !errorReason,
    network: 'stellar:testnet' as const,
    transaction,
    ...(errorReason ? { errorReason } : {}),
  });

  it('leaves the row pending when the engine reports another transaction', async () => {
    const row = await pending();

    await records().recordEngineResult(row, result(randomBytes(32).toString('hex')));

    expect(await statusOf(row)).toBe('pending');
  });

  it('finishes the row as success when the engine reports its transaction settled', async () => {
    const row = await pending();

    await records().recordEngineResult(row, result(hashOf(row)));

    expect(await statusOf(row)).toBe('success');
  });

  it.each(['invalid_transaction_state', 'settle_upto_transaction_failed'])(
    'finishes the row as failed when the engine reports %s for its transaction',
    async (reason) => {
      const row = await pending();

      await records().recordEngineResult(row, result(hashOf(row), reason));

      expect(await statusOf(row)).toBe('failed');
    },
  );

  it('leaves the row pending when the engine cannot tell what happened to its transaction', async () => {
    const row = await pending();

    await records().recordEngineResult(row, result(hashOf(row), 'settlement_pending'));

    expect(await statusOf(row)).toBe('pending');
  });
});
