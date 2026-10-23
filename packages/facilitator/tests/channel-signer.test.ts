import { randomBytes } from 'node:crypto';
import {
  Account,
  Asset,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
} from '@stellar/stellar-sdk';
import { describe, expect, it, vi } from 'vitest';
import {
  EnvSignerProvider,
  withSignerCache,
  type SignerProvider,
  type StellarSigner,
} from '../src/modules/channels/core/stellar-signer.js';

const randomKeypair = () => Keypair.fromRawEd25519Seed(randomBytes(32));

function unsignedTx(source: string): string {
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
    .setTimeout(60)
    .build()
    .toXDR();
}

function fakeSigner(address: string): StellarSigner {
  return {
    address,
    signTransaction: vi.fn(),
    signAuthEntry: vi.fn(),
  };
}

describe('environment channel signers', () => {
  it('loads a signer for the address a configured secret derives', async () => {
    const channel = randomKeypair();
    const provider = new EnvSignerProvider([channel.secret()], Networks.TESTNET);

    const loaded = await provider.load(channel.publicKey());

    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    const { signedTxXdr } = await loaded.signer.signTransaction(unsignedTx(channel.publicKey()));
    const signed = TransactionBuilder.fromXDR(signedTxXdr, Networks.TESTNET);
    expect(channel.verify(signed.hash(), signed.signatures[0]!.signature())).toBe(true);
  });

  it('reports an address no configured secret derives as a wrong account', async () => {
    const provider = new EnvSignerProvider([randomKeypair().secret()], Networks.TESTNET);

    const loaded = await provider.load(randomKeypair().publicKey());

    expect(loaded).toEqual({ ok: false, reason: expect.stringContaining('no configured secret') });
  });

  it('lists the configured addresses for seeding an empty pool', () => {
    const [a, b] = [randomKeypair(), randomKeypair()];
    const provider = new EnvSignerProvider([a.secret(), b.secret()], Networks.TESTNET);

    expect(provider.addresses()).toEqual([a.publicKey(), b.publicKey()]);
  });
});

describe('signer cache', () => {
  const address = randomKeypair().publicKey();

  function providerReturning(...results: Array<() => ReturnType<SignerProvider['load']>>) {
    const load = vi.fn<SignerProvider['load']>();
    for (const result of results) load.mockImplementationOnce(result);
    return { provider: { mode: 'test', load } satisfies SignerProvider, load };
  }

  it('creates a signer once and reuses it', async () => {
    const signer = fakeSigner(address);
    const { provider, load } = providerReturning(async () => ({ ok: true, signer }));
    const cached = withSignerCache(provider);

    await cached.load(address);
    const second = await cached.load(address);

    expect(second).toEqual({ ok: true, signer });
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('does not cache a wrong account, so the next load asks the provider again', async () => {
    const { provider, load } = providerReturning(
      async () => ({ ok: false, reason: 'mismatch' }),
      async () => ({ ok: false, reason: 'mismatch' }),
    );
    const cached = withSignerCache(provider);

    await cached.load(address);
    await cached.load(address);

    expect(load).toHaveBeenCalledTimes(2);
  });

  it('passes an unreachable key store through as an error and caches nothing', async () => {
    const signer = fakeSigner(address);
    const { provider, load } = providerReturning(
      async () => {
        throw new Error('ThrottlingException');
      },
      async () => ({ ok: true, signer }),
    );
    const cached = withSignerCache(provider);

    await expect(cached.load(address)).rejects.toThrow('ThrottlingException');
    await expect(cached.load(address)).resolves.toEqual({ ok: true, signer });
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('rejects a member that is not a G address without asking the provider', async () => {
    const { provider, load } = providerReturning();
    const cached = withSignerCache(provider);

    await expect(cached.load('not-an-address')).resolves.toEqual({
      ok: false,
      reason: 'not a Stellar G address',
    });
    expect(load).not.toHaveBeenCalled();
  });
});
