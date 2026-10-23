import { createHash, randomBytes } from 'node:crypto';
import {
  Account,
  FeeBumpTransaction,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
} from '@stellar/stellar-sdk';
import { createEd25519Signer } from '@x402/stellar';
import type { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SHARED_KEY_RESOURCE_SERVER_ID } from '../src/models/credentials/resource-server.model.js';
import type { Database } from '../src/models/database.js';
import { SettlementRepository } from '../src/modules/x402/repositories/settlement.repository.js';
import {
  SettlementJournal,
  type SettlementDraft,
} from '../src/modules/x402/services/persistence/settlement-journal.js';
import { unsignedFeeBump } from './settlement-fixtures.js';

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const channel = Keypair.random();
const feePayerKey = Keypair.random();
const feePayer = createEd25519Signer(feePayerKey.secret(), 'stellar:testnet');

let db: Kysely<Database>;
let repository: SettlementRepository;
let journal: SettlementJournal;

beforeEach(async () => {
  const { createTestDatabase } = await import('./test-database.js');
  db = await createTestDatabase();
  repository = new SettlementRepository(db);
  journal = new SettlementJournal(repository, Networks.TESTNET, log);
});

afterEach(async () => {
  await db.destroy();
});

function draft(): SettlementDraft {
  return {
    resourceServerId: SHARED_KEY_RESOURCE_SERVER_ID,
    network: 'stellar:testnet',
    scheme: 'exact',
    asset: 'C_USDC',
    payTo: 'G_PAY_TO',
    payer: 'G_PAYER',
    signatureDigest: createHash('sha256').update(randomBytes(8)).digest(),
    actualAmount: '10000',
  };
}

const sign = (signer: typeof feePayer, sequence = '41') =>
  signer.signTransaction(unsignedFeeBump(channel, feePayerKey.publicKey(), sequence), {
    networkPassphrase: Networks.TESTNET,
  });

describe('SettlementJournal', () => {
  it('stores the signed envelope before returning the fee payer’s signature', async () => {
    const guarded = journal.guardFinalSigner(feePayer);
    const { result: signed, outcome } = await journal.run(draft(), () => sign(guarded));

    expect(outcome?.kind).toBe('recorded');
    const envelope = TransactionBuilder.fromXDR(signed.signedTxXdr, Networks.TESTNET);
    expect(envelope).toBeInstanceOf(FeeBumpTransaction);
    const fee = envelope as FeeBumpTransaction;
    if (outcome?.kind !== 'recorded') return;
    expect(outcome.settlement).toMatchObject({
      status: 'pending',
      feePayerAddress: feePayerKey.publicKey(),
      channelAccountAddress: channel.publicKey(),
      channelAccountSequence: 42n,
    });
    expect(Buffer.from(outcome.settlement.txHash)).toEqual(fee.hash());
    expect(Buffer.from(outcome.settlement.signedXdr).toString('base64')).toBe(signed.signedTxXdr);
    expect(outcome.settlement.validUntil.getTime()).toBe(
      Number(fee.innerTransaction.timeBounds!.maxTime) * 1000,
    );
  });

  it('withholds the signature when the authorization was already recorded', async () => {
    const guarded = journal.guardFinalSigner(feePayer);
    const same = draft();
    await journal.run(same, () => sign(guarded, '41'));
    const { result, outcome } = await journal.run(same, () => sign(guarded, '90'));

    expect(outcome?.kind).toBe('duplicate');
    expect(result.signedTxXdr).toBe('');
    expect(result.error?.message).toMatch(/refusing to broadcast/);
  });

  it('withholds the signature when the settlement cannot be stored', async () => {
    const failing = new SettlementJournal(
      { insertPrepared: () => Promise.reject(new Error('database down')) } as never,
      Networks.TESTNET,
      log,
    );
    const { result, outcome } = await failing.run(draft(), () =>
      sign(failing.guardFinalSigner(feePayer)),
    );

    expect(outcome).toEqual({ kind: 'store-failed' });
    expect(result.signedTxXdr).toBe('');
    expect(log.error).toHaveBeenCalledWith('settlement_store_failed', { errorName: 'Error' });
  });

  it('withholds a final signature that is not on a fee-bump, and stores nothing', async () => {
    const plain = new TransactionBuilder(new Account(channel.publicKey(), '41'), {
      fee: '100',
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(Operation.bumpSequence({ bumpTo: '0' }))
      .setTimeout(60)
      .build()
      .toXDR();
    const guarded = journal.guardFinalSigner(feePayer);
    const same = draft();

    const { result, outcome } = await journal.run(same, () =>
      guarded.signTransaction(plain, { networkPassphrase: Networks.TESTNET }),
    );

    expect(outcome).toEqual({ kind: 'store-failed' });
    expect(result.signedTxXdr).toBe('');
    expect(await repository.findBySignatureDigest(same.signatureDigest)).toBeUndefined();
  });

  it('withholds the signature on a transaction with no upper time bound, and stores nothing', async () => {
    const guarded = journal.guardFinalSigner(feePayer);
    const same = draft();
    const unbounded = unsignedFeeBump(channel, feePayerKey.publicKey(), '41', 0);

    const { result, outcome } = await journal.run(same, () =>
      guarded.signTransaction(unbounded, { networkPassphrase: Networks.TESTNET }),
    );

    expect(outcome).toEqual({ kind: 'store-failed' });
    expect(result.signedTxXdr).toBe('');
    expect(await repository.findBySignatureDigest(same.signatureDigest)).toBeUndefined();
  });

  it('signs unchanged outside a settlement', async () => {
    const result = await sign(journal.guardFinalSigner(feePayer));
    expect(result.error).toBeUndefined();
    expect(result.signedTxXdr).not.toBe('');
  });
});
