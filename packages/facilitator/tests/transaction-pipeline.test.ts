import { randomBytes } from 'node:crypto';
import type { Transaction } from '@stellar/stellar-sdk';
import {
  Account,
  Asset,
  FeeBumpTransaction,
  Keypair,
  Networks,
  Operation,
  TimeoutInfinite,
  TransactionBuilder,
} from '@stellar/stellar-sdk';
import { describe, expect, it, vi } from 'vitest';
import {
  EnvSignerProvider,
  type StellarSigner,
} from '../src/modules/channels/core/stellar-signer.js';
import {
  TransactionPipeline,
  TransactionSigningError,
  type PipelineRpc,
} from '../src/modules/channels/core/transaction-pipeline.js';
import { FakeClock } from './fake-lease-store.js';

const randomKeypair = () => Keypair.fromRawEd25519Seed(randomBytes(32));

function innerTx(source: string, timeoutSeconds = 60): Transaction {
  return new TransactionBuilder(new Account(source, '1'), {
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
    .setTimeout(timeoutSeconds)
    .build();
}

async function envSigner(keypair: Keypair): Promise<StellarSigner> {
  const loaded = await new EnvSignerProvider([keypair.secret()], Networks.TESTNET).load(
    keypair.publicKey(),
  );
  if (!loaded.ok) throw new Error('test signer did not load');
  return loaded.signer;
}

function signerReturning(address: string, signTransaction: StellarSigner['signTransaction']) {
  return { address, signTransaction, signAuthEntry: vi.fn() } satisfies StellarSigner;
}

/** `sendTransaction` answers `sendStatus`; `getTransaction` answers each status in turn. */
function fakeRpc(sendStatus: string, ...statuses: string[]) {
  const getTransaction = vi.fn(async () => ({ status: statuses.shift() ?? 'NOT_FOUND' }));
  const sendTransaction = vi.fn(async () => ({ status: sendStatus }));
  return { sendTransaction, getTransaction } satisfies PipelineRpc;
}

function pipelineWith(rpc: PipelineRpc, clock = new FakeClock()) {
  const pipeline = new TransactionPipeline({
    rpc,
    networkPassphrase: Networks.TESTNET,
    confirmWaitMs: 20_000,
    pollMs: 1_000,
    clock,
  });
  return { pipeline, clock };
}

async function sponsored(pipeline: TransactionPipeline, timeoutSeconds = 60) {
  const [channel, feePayer] = [randomKeypair(), randomKeypair()];
  return pipeline.sponsor(
    innerTx(channel.publicKey(), timeoutSeconds),
    await envSigner(channel),
    await envSigner(feePayer),
    '100',
  );
}

describe('sponsoring a channel transaction', () => {
  it('has the channel sign the inner transaction and the fee payer sign and pay the fee-bump', async () => {
    const [channel, feePayer] = [randomKeypair(), randomKeypair()];
    const { pipeline } = pipelineWith(fakeRpc('PENDING'));

    const envelope = await pipeline.sponsor(
      innerTx(channel.publicKey()),
      await envSigner(channel),
      await envSigner(feePayer),
      '100',
    );

    expect(envelope).toBeInstanceOf(FeeBumpTransaction);
    expect(envelope.feeSource).toBe(feePayer.publicKey());
    const inner = envelope.innerTransaction;
    expect(inner.source).toBe(channel.publicKey());
    expect(channel.verify(inner.hash(), inner.signatures[0]!.signature())).toBe(true);
    expect(feePayer.verify(envelope.hash(), envelope.signatures[0]!.signature())).toBe(true);
  });

  it('reports a signer that returns an error as a signing failure', async () => {
    const channel = randomKeypair();
    const failing = signerReturning(channel.publicKey(), async () => ({
      signedTxXdr: '',
      error: { message: 'KMS throttled', code: -1 },
    }));
    const { pipeline } = pipelineWith(fakeRpc('PENDING'));

    await expect(
      pipeline.sponsor(
        innerTx(channel.publicKey()),
        failing,
        await envSigner(randomKeypair()),
        '100',
      ),
    ).rejects.toThrow(TransactionSigningError);
  });

  it('reports a signer that throws as a signing failure, keeping the cause', async () => {
    const channel = randomKeypair();
    const cause = new Error('socket hang up');
    const throwing = signerReturning(channel.publicKey(), async () => {
      throw cause;
    });
    const { pipeline } = pipelineWith(fakeRpc('PENDING'));

    const failure = pipeline.sponsor(
      innerTx(channel.publicKey()),
      throwing,
      await envSigner(randomKeypair()),
      '100',
    );

    await expect(failure).rejects.toMatchObject({ name: 'TransactionSigningError', cause });
  });

  it('rejects a signature reported as made by another address', async () => {
    const channel = randomKeypair();
    const impostor = signerReturning(channel.publicKey(), async (xdr) => ({
      signedTxXdr: xdr,
      signerAddress: randomKeypair().publicKey(),
    }));
    const { pipeline } = pipelineWith(fakeRpc('PENDING'));

    await expect(
      pipeline.sponsor(
        innerTx(channel.publicKey()),
        impostor,
        await envSigner(randomKeypair()),
        '100',
      ),
    ).rejects.toThrow(/was signed by/);
  });
});

describe('checking what each signer returns', () => {
  it('rejects a channel signer that returns a fee-bump instead of the transaction', async () => {
    const channel = randomKeypair();
    const inner = innerTx(channel.publicKey());
    const wrapped = TransactionBuilder.buildFeeBumpTransaction(
      randomKeypair().publicKey(),
      '200',
      inner,
      Networks.TESTNET,
    ).toXDR();
    const wrapping = signerReturning(channel.publicKey(), async () => ({
      signedTxXdr: wrapped,
      signerAddress: channel.publicKey(),
    }));
    const { pipeline } = pipelineWith(fakeRpc('PENDING'));

    await expect(
      pipeline.sponsor(inner, wrapping, await envSigner(randomKeypair()), '100'),
    ).rejects.toMatchObject({
      name: 'TransactionSigningError',
      message: `${channel.publicKey()} returned a fee-bump transaction`,
    });
  });

  it('rejects a fee payer that returns the inner transaction instead of the fee-bump', async () => {
    const [channel, feePayer] = [randomKeypair(), randomKeypair()];
    const inner = innerTx(channel.publicKey());
    const unwrapping = signerReturning(feePayer.publicKey(), async () => ({
      signedTxXdr: inner.toXDR(),
      signerAddress: feePayer.publicKey(),
    }));
    const { pipeline } = pipelineWith(fakeRpc('PENDING'));

    await expect(
      pipeline.sponsor(inner, await envSigner(channel), unwrapping, '100'),
    ).rejects.toMatchObject({
      name: 'TransactionSigningError',
      message: `${feePayer.publicKey()} did not return a fee-bump transaction`,
    });
  });
});

describe('submitting a sponsored transaction', () => {
  it('reports a transaction confirmed as successful as included', async () => {
    const { pipeline } = pipelineWith(fakeRpc('PENDING', 'NOT_FOUND', 'SUCCESS'));
    const envelope = await sponsored(pipeline);

    await expect(pipeline.submit(envelope)).resolves.toEqual({
      kind: 'included',
      hash: envelope.hash().toString('hex'),
      successful: true,
    });
  });

  it('reports a transaction that failed on-chain as included, not successful', async () => {
    const { pipeline } = pipelineWith(fakeRpc('PENDING', 'FAILED'));
    const envelope = await sponsored(pipeline);

    await expect(pipeline.submit(envelope)).resolves.toMatchObject({
      kind: 'included',
      successful: false,
    });
  });

  it('waits for a transaction the node already had', async () => {
    const { pipeline } = pipelineWith(fakeRpc('DUPLICATE', 'SUCCESS'));
    const envelope = await sponsored(pipeline);

    await expect(pipeline.submit(envelope)).resolves.toMatchObject({ kind: 'included' });
  });

  it.each(['ERROR', 'TRY_AGAIN_LATER'])('reports a %s send as rejected', async (status) => {
    const rpc = fakeRpc(status);
    const { pipeline } = pipelineWith(rpc);
    const envelope = await sponsored(pipeline);

    await expect(pipeline.submit(envelope)).resolves.toEqual({
      kind: 'rejected',
      hash: envelope.hash().toString('hex'),
      status,
    });
    expect(rpc.getTransaction).not.toHaveBeenCalled();
  });

  it('reports a send that throws as unknown, with the hash and the validity window', async () => {
    const rpc = fakeRpc('PENDING');
    rpc.sendTransaction.mockRejectedValueOnce(new Error('ECONNRESET'));
    const { pipeline } = pipelineWith(rpc);
    const envelope = await sponsored(pipeline);
    const maxTime = Number(envelope.innerTransaction.timeBounds!.maxTime);

    await expect(pipeline.submit(envelope)).resolves.toEqual({
      kind: 'unknown',
      hash: envelope.hash().toString('hex'),
      validUntilMs: maxTime * 1000,
    });
  });

  it('reports a transaction still unconfirmed when the wait ends as unknown', async () => {
    const rpc = fakeRpc('PENDING');
    const { pipeline, clock } = pipelineWith(rpc);
    const envelope = await sponsored(pipeline);
    const started = clock.now();

    await expect(pipeline.submit(envelope)).resolves.toMatchObject({ kind: 'unknown' });
    expect(clock.now() - started).toBeGreaterThanOrEqual(20_000);
    expect(rpc.getTransaction.mock.calls.length).toBeGreaterThan(1);
  });

  it('keeps polling through RPC errors while confirming', async () => {
    const rpc = fakeRpc('PENDING', 'SUCCESS');
    rpc.getTransaction.mockRejectedValueOnce(new Error('503'));
    const { pipeline } = pipelineWith(rpc);
    const envelope = await sponsored(pipeline);

    await expect(pipeline.submit(envelope)).resolves.toMatchObject({ kind: 'included' });
  });

  it('refuses, before sending, an envelope with no upper time bound', async () => {
    const rpc = fakeRpc('PENDING');
    const { pipeline } = pipelineWith(rpc);
    const envelope = await sponsored(pipeline, TimeoutInfinite);

    await expect(pipeline.submit(envelope)).rejects.toThrow(/upper time bound/);
    expect(rpc.sendTransaction).not.toHaveBeenCalled();
  });
});
