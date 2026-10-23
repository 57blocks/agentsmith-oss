import { createHash, randomBytes } from 'node:crypto';
import {
  Account,
  Asset,
  FeeBumpTransaction,
  Keypair,
  Networks,
  Operation,
  SorobanDataBuilder,
  TransactionBuilder,
  rpc,
  type Transaction,
} from '@stellar/stellar-sdk';
import type { PaymentPayload, PaymentRequirements } from '@x402/core/types';
import { createEd25519Signer } from '@x402/stellar';
import { ExactStellarScheme } from '@x402/stellar/exact/facilitator';
import type { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SHARED_KEY_RESOURCE_SERVER_ID } from '../src/models/credentials/resource-server.model.js';
import type { Database } from '../src/models/database.js';
import { TransactionPipeline } from '../src/modules/channels/core/transaction-pipeline.js';
import { withFeeBumpBid } from '../src/modules/x402/services/fees/priced-fee-payer.js';
import { SettlementRepository } from '../src/modules/x402/repositories/settlement.repository.js';
import { SettlementJournal } from '../src/modules/x402/services/persistence/settlement-journal.js';
import { asset, exactPaymentXdr, payTo } from './settlement-fixtures.js';
import { createTestDatabase } from './test-database.js';

const BID = 700;
const RESOURCE_FEE = 31_155;
const bid = { currentStroops: async () => BID };
const randomKeypair = () => Keypair.fromRawEd25519Seed(randomBytes(32));

/** A channel-signed Soroban-shaped inner transaction, bidding the minimum like both schemes do. */
function signedInner(channel: Keypair): Transaction {
  const inner = new TransactionBuilder(new Account(channel.publicKey(), '41'), {
    fee: '100',
    networkPassphrase: Networks.TESTNET,
    sorobanData: new SorobanDataBuilder().setResourceFee(RESOURCE_FEE).build(),
  })
    .addOperation(Operation.payment({ destination: payTo, asset: Asset.native(), amount: '1' }))
    .setTimeout(60)
    .build();
  inner.sign(channel);
  return inner;
}

function minimumFeeBump(feePayer: string, inner: Transaction): string {
  return TransactionBuilder.buildFeeBumpTransaction(
    feePayer,
    '100',
    inner,
    Networks.TESTNET,
  ).toXDR();
}

function parsedFeeBump(xdr: string): FeeBumpTransaction {
  const envelope = TransactionBuilder.fromXDR(xdr, Networks.TESTNET);
  if (!(envelope instanceof FeeBumpTransaction)) throw new Error('not a fee-bump');
  return envelope;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('fee payer pricing each fee-bump', () => {
  it('rebuilds the fee-bump at the current bid around the unchanged signed inner transaction', async () => {
    const [channel, feePayerKey] = [randomKeypair(), randomKeypair()];
    const feePayer = withFeeBumpBid(
      createEd25519Signer(feePayerKey.secret()),
      bid,
      Networks.TESTNET,
    );
    const inner = signedInner(channel);

    const result = await feePayer.signTransaction(minimumFeeBump(feePayerKey.publicKey(), inner));

    const signed = parsedFeeBump(result.signedTxXdr);
    expect(result.signerAddress).toBe(feePayerKey.publicKey());
    expect(signed.feeSource).toBe(feePayerKey.publicKey());
    expect(signed.fee).toBe(String(RESOURCE_FEE + 2 * BID));
    expect(signed.innerTransaction.toXDR()).toBe(inner.toXDR());
    expect(channel.verify(inner.hash(), signed.innerTransaction.signatures[0]!.signature())).toBe(
      true,
    );
    expect(feePayerKey.verify(signed.hash(), signed.signatures[0]!.signature())).toBe(true);
  });

  it('refuses a transaction that is not a fee-bump, without signing it', async () => {
    const feePayerKey = randomKeypair();
    const wrapped = createEd25519Signer(feePayerKey.secret());
    const sign = vi.spyOn(wrapped, 'signTransaction');
    const feePayer = withFeeBumpBid(wrapped, bid, Networks.TESTNET);

    const result = await feePayer.signTransaction(signedInner(randomKeypair()).toXDR());

    expect(result).toEqual({
      signedTxXdr: '',
      signerAddress: feePayerKey.publicKey(),
      error: { message: 'the fee payer signs only fee-bumps it pays for', code: -1 },
    });
    expect(sign).not.toHaveBeenCalled();
  });

  it('refuses a fee-bump paid by another account, without signing it', async () => {
    const feePayerKey = randomKeypair();
    const wrapped = createEd25519Signer(feePayerKey.secret());
    const sign = vi.spyOn(wrapped, 'signTransaction');
    const feePayer = withFeeBumpBid(wrapped, bid, Networks.TESTNET);

    const result = await feePayer.signTransaction(
      minimumFeeBump(randomKeypair().publicKey(), signedInner(randomKeypair())),
    );

    expect(result.error?.message).toBe('the fee payer signs only fee-bumps it pays for');
    expect(sign).not.toHaveBeenCalled();
  });

  it("passes the fee payer signer's failure through unchanged", async () => {
    const [channel, feePayerKey] = [randomKeypair(), randomKeypair()];
    const failure = {
      signedTxXdr: '',
      signerAddress: feePayerKey.publicKey(),
      error: { message: 'ThrottlingException', code: -1 },
    };
    const wrapped = createEd25519Signer(feePayerKey.secret());
    vi.spyOn(wrapped, 'signTransaction').mockResolvedValue(failure);
    const feePayer = withFeeBumpBid(wrapped, bid, Networks.TESTNET);

    const result = await feePayer.signTransaction(
      minimumFeeBump(feePayerKey.publicKey(), signedInner(channel)),
    );

    expect(result).toEqual(failure);
  });

  it('reads and signs under the passphrase the caller names', async () => {
    const [channel, feePayerKey] = [randomKeypair(), randomKeypair()];
    const inner = new TransactionBuilder(new Account(channel.publicKey(), '41'), {
      fee: '100',
      networkPassphrase: Networks.PUBLIC,
    })
      .addOperation(Operation.payment({ destination: payTo, asset: Asset.native(), amount: '1' }))
      .setTimeout(60)
      .build();
    inner.sign(channel);
    const envelope = TransactionBuilder.buildFeeBumpTransaction(
      feePayerKey.publicKey(),
      '100',
      inner,
      Networks.PUBLIC,
    );
    const feePayer = withFeeBumpBid(
      createEd25519Signer(feePayerKey.secret()),
      bid,
      Networks.TESTNET,
    );

    const result = await feePayer.signTransaction(envelope.toXDR(), {
      networkPassphrase: Networks.PUBLIC,
    });

    const signed = TransactionBuilder.fromXDR(result.signedTxXdr, Networks.PUBLIC);
    expect(signed).toBeInstanceOf(FeeBumpTransaction);
    expect(feePayerKey.verify(signed.hash(), signed.signatures[0]!.signature())).toBe(true);
  });

  it('refuses, rather than throws, when the fee-bump cannot be rebuilt at the bid', async () => {
    const [channel, feePayerKey] = [randomKeypair(), randomKeypair()];
    const wrapped = createEd25519Signer(feePayerKey.secret());
    const sign = vi.spyOn(wrapped, 'signTransaction');
    const feePayer = withFeeBumpBid(wrapped, { currentStroops: async () => 50 }, Networks.TESTNET);

    const result = await feePayer.signTransaction(
      minimumFeeBump(feePayerKey.publicKey(), signedInner(channel)),
    );

    expect(result.signedTxXdr).toBe('');
    expect(result.error?.code).toBe(-1);
    expect(result.error?.message).toMatch(/^the fee-bump could not be rebuilt at 50 stroops: /);
    expect(sign).not.toHaveBeenCalled();
  });

  it('refuses an envelope it cannot read', async () => {
    const feePayer = withFeeBumpBid(
      createEd25519Signer(randomKeypair().secret()),
      bid,
      Networks.TESTNET,
    );

    const result = await feePayer.signTransaction('not-a-transaction');

    expect(result.error?.message).toBe('the fee payer was given an envelope it cannot read');
  });
});

describe('upto sponsorship through a priced fee payer', () => {
  it('submits the fee-bump at the current bid', async () => {
    const [channel, feePayerKey] = [randomKeypair(), randomKeypair()];
    const pipeline = new TransactionPipeline({
      rpc: { sendTransaction: vi.fn(), getTransaction: vi.fn() },
      networkPassphrase: Networks.TESTNET,
      confirmWaitMs: 1_000,
      pollMs: 100,
    });
    const inner = signedInner(channel);
    inner.signatures.length = 0;

    const envelope = await pipeline.sponsor(
      inner,
      createEd25519Signer(channel.secret()),
      withFeeBumpBid(createEd25519Signer(feePayerKey.secret()), bid, Networks.TESTNET),
      '100',
    );

    expect(envelope.feeSource).toBe(feePayerKey.publicKey());
    expect(envelope.fee).toBe(String(RESOURCE_FEE + 2 * BID));
  });
});

describe('upstream exact settle through a priced, journaled fee payer', () => {
  const channelKey = randomKeypair();
  const feePayerKey = randomKeypair();
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
  let submitted: Transaction | FeeBumpTransaction | undefined;

  beforeEach(async () => {
    db = await createTestDatabase();
    submitted = undefined;
    vi.spyOn(rpc.Server.prototype, 'getAccount').mockResolvedValue(
      new Account(channelKey.publicKey(), '41'),
    );
    vi.spyOn(rpc.Server.prototype, 'sendTransaction').mockImplementation(async (tx) => {
      submitted = tx;
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
    await db.destroy();
  });

  // Pins upstream behaviour the bid relies on: it submits the envelope its fee-bump signer returns.
  it('submits and records the fee-bump at the current bid', async () => {
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const journal = new SettlementJournal(new SettlementRepository(db), Networks.TESTNET, log);
    const feePayer = journal.guardFinalSigner(
      withFeeBumpBid(createEd25519Signer(feePayerKey.secret()), bid, Networks.TESTNET),
    );
    const scheme = new ExactStellarScheme([createEd25519Signer(channelKey.secret())], {
      feeBumpSigner: feePayer,
    });
    // Verification simulates against a live node; this test is about the fee-bump after it.
    const internals = scheme as unknown as { _verify: () => Promise<unknown> };
    vi.spyOn(internals, '_verify').mockResolvedValue({
      response: { isValid: true, payer: 'G_PAYER' },
      simResponse: { transactionData: new SorobanDataBuilder().setResourceFee(RESOURCE_FEE) },
    });
    const draft = {
      resourceServerId: SHARED_KEY_RESOURCE_SERVER_ID,
      network: 'stellar:testnet',
      scheme: 'exact' as const,
      asset,
      payTo,
      payer: Keypair.random().publicKey(),
      signatureDigest: createHash('sha256').update(randomBytes(8)).digest(),
      actualAmount: '10000',
    };

    const { result } = await journal.run(draft, () => scheme.settle(payload, requirements));

    expect(result).toMatchObject({ success: true });
    expect(submitted).toBeInstanceOf(FeeBumpTransaction);
    expect(submitted!.fee).toBe(String(RESOURCE_FEE + 2 * BID));
    const [row] = await db.selectFrom('settlements').select(['signedXdr', 'txHash']).execute();
    expect(Buffer.from(row!.signedXdr)).toEqual(submitted!.toEnvelope().toXDR());
    expect(Buffer.from(row!.txHash).toString('hex')).toBe(result.transaction);
  });
});
