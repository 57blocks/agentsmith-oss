import { randomBytes } from 'node:crypto';
import { Keypair, Networks } from '@stellar/stellar-sdk';
import { describe, expect, it, vi } from 'vitest';
import { KmsSignerProvider } from '../src/modules/channels/kms/kms-signer-provider.js';
import type { KmsSigningClient } from '../src/modules/channels/kms/kms-signer.js';
import { arnOf, fakeKms } from './fake-kms.js';

const randomKeypair = () => Keypair.fromRawEd25519Seed(randomBytes(32));
const silent = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() });

function provider(client: KmsSigningClient, log = silent()) {
  return new KmsSignerProvider(client, Networks.TESTNET, log);
}

function failingWith(name: string): KmsSigningClient {
  const error = new Error(`${name}: simulated`);
  error.name = name;
  return {
    getPublicKey: async () => {
      throw error;
    },
    sign: async () => {
      throw error;
    },
  };
}

describe('KMS channel signer provider', () => {
  it('loads a channel key under its channel alias and logs the address to key ARN mapping', async () => {
    const channel = randomKeypair();
    const kms = fakeKms([channel]);
    const log = silent();

    const loaded = await provider(kms.client, log).load(channel.publicKey());

    expect(loaded).toMatchObject({ ok: true, signer: { address: channel.publicKey() } });
    expect(kms.calls).toEqual([
      { op: 'getPublicKey', keyId: `alias/x402/channel/${channel.publicKey()}` },
    ]);
    expect(log.info).toHaveBeenCalledWith('kms_signer_loaded', {
      role: 'channel',
      address: channel.publicKey(),
      keyArn: arnOf(channel),
    });
  });

  it('treats an alias that points at another key as a wrong account', async () => {
    const channel = randomKeypair();
    const kms = fakeKms([], { aliasTo: { [channel.publicKey()]: randomKeypair() } });

    const loaded = await provider(kms.client).load(channel.publicKey());

    expect(loaded).toEqual({ ok: false, reason: expect.stringMatching(/resolves to G/) });
  });

  it('treats a key of the wrong spec as a wrong account', async () => {
    const channel = randomKeypair();
    const kms = fakeKms([channel], { keySpec: 'RSA_2048' });

    expect(await provider(kms.client).load(channel.publicKey())).toMatchObject({ ok: false });
  });

  it('treats a missing channel alias as a wrong account', async () => {
    const loaded = await provider(fakeKms([]).client).load(randomKeypair().publicKey());

    expect(loaded).toEqual({ ok: false, reason: 'no KMS channel alias for this address' });
  });

  it('does not load a key whose alias exists only under another role', async () => {
    const key = randomKeypair();
    const kms = fakeKms([key], { roles: { [key.publicKey()]: 'fee-payer' } });

    expect(await provider(kms.client).load(key.publicKey())).toMatchObject({ ok: false });
  });

  it.each(['ThrottlingException', 'TimeoutError', 'AccessDeniedException', 'KMSInternalException'])(
    'throws on %s, so the member is skipped rather than removed',
    async (name) => {
      await expect(provider(failingWith(name)).load(randomKeypair().publicKey())).rejects.toThrow(
        name,
      );
    },
  );
});
