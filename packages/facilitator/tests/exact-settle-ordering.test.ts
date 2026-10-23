import { createHash, randomBytes } from 'node:crypto';
import { Account, Keypair, Networks, SorobanDataBuilder, rpc } from '@stellar/stellar-sdk';
import type { PaymentPayload, PaymentRequirements } from '@x402/core/types';
import { createEd25519Signer } from '@x402/stellar';
import { ExactStellarScheme } from '@x402/stellar/exact/facilitator';
import type { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SHARED_KEY_RESOURCE_SERVER_ID } from '../src/models/credentials/resource-server.model.js';
import type { Database } from '../src/models/database.js';
import { SettlementRepository } from '../src/modules/x402/repositories/settlement.repository.js';
import { SettlementJournal } from '../src/modules/x402/services/persistence/settlement-journal.js';
import { asset, exactPaymentXdr, payTo } from './settlement-fixtures.js';
import { createTestDatabase } from './test-database.js';

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const channel = Keypair.random();
const feePayerKey = Keypair.random();

const requirements: PaymentRequirements = {
  scheme: 'exact',
  network: 'stellar:testnet',
  asset,
  payTo,
  amount: '10000',
  maxTimeoutSeconds: 1,
  extra: { areFeesSponsored: true },
};
const payload: PaymentPayload = {
  x402Version: 2,
  accepted: requirements,
  payload: { transaction: exactPaymentXdr() },
};

let db: Kysely<Database>;
let events: string[];

beforeEach(async () => {
  db = await createTestDatabase();
  events = [];
  vi.spyOn(rpc.Server.prototype, 'getAccount').mockResolvedValue(
    new Account(channel.publicKey(), '41'),
  );
  vi.spyOn(rpc.Server.prototype, 'sendTransaction').mockImplementation(async (tx) => {
    const stored = await db.selectFrom('settlements').select('txHash').execute();
    events.push(`send:${stored.length}`);
    return {
      status: 'PENDING',
      hash: tx.hash().toString('hex'),
    } as rpc.Api.SendTransactionResponse;
  });
  vi.spyOn(rpc.Server.prototype, 'getTransaction').mockResolvedValue({
    status: rpc.Api.GetTransactionStatus.SUCCESS,
  } as rpc.Api.GetTransactionResponse);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await db.destroy();
});

/** The upstream scheme, unchanged, with only its fee payer guarded by the journal. */
function upstreamScheme(journal: SettlementJournal) {
  const feePayer = createEd25519Signer(feePayerKey.secret(), 'stellar:testnet');
  const scheme = new ExactStellarScheme(
    [createEd25519Signer(channel.secret(), 'stellar:testnet')],
    {
      feeBumpSigner: journal.guardFinalSigner(feePayer),
    },
  );
  // Verification simulates against a live node; this test is about what happens after it.
  const internals = scheme as unknown as { _verify: () => Promise<unknown> };
  vi.spyOn(internals, '_verify').mockResolvedValue({
    response: { isValid: true, payer: 'G_PAYER' },
    simResponse: { transactionData: new SorobanDataBuilder() },
  });
  return scheme;
}

function draft() {
  return {
    resourceServerId: SHARED_KEY_RESOURCE_SERVER_ID,
    network: 'stellar:testnet',
    scheme: 'exact' as const,
    asset,
    payTo,
    payer: Keypair.random().publicKey(),
    signatureDigest: createHash('sha256').update(randomBytes(8)).digest(),
    actualAmount: '10000',
  };
}

describe('upstream exact settle with a guarded fee payer', () => {
  it('stores the signed settlement before the transaction is sent', async () => {
    const journal = new SettlementJournal(new SettlementRepository(db), Networks.TESTNET, log);
    const scheme = upstreamScheme(journal);

    const { result, outcome } = await journal.run(draft(), () =>
      scheme.settle(payload, requirements),
    );

    expect(outcome?.kind).toBe('recorded');
    expect(events).toEqual(['send:1']);
    expect(result).toMatchObject({ success: true });
    const [row] = await db.selectFrom('settlements').select('txHash').execute();
    expect(Buffer.from(row!.txHash).toString('hex')).toBe(result.transaction);
  });

  it('sends nothing when the settlement cannot be stored', async () => {
    const repository = new SettlementRepository(db);
    vi.spyOn(repository, 'insertPrepared').mockRejectedValue(new Error('database unavailable'));
    const journal = new SettlementJournal(repository, Networks.TESTNET, log);
    const scheme = upstreamScheme(journal);

    const { result, outcome } = await journal.run(draft(), () =>
      scheme.settle(payload, requirements),
    );

    expect(outcome?.kind).toBe('store-failed');
    expect(result).toMatchObject({
      success: false,
      errorReason: 'settle_exact_stellar_fee_bump_signing_failed',
    });
    expect(rpc.Server.prototype.sendTransaction).not.toHaveBeenCalled();
  });
});
