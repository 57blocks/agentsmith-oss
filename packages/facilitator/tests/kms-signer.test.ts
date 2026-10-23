import { randomBytes } from 'node:crypto';
import {
  Account,
  Asset,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
} from '@stellar/stellar-sdk';
import { createEd25519Signer } from '@x402/stellar';
import { describe, expect, it, vi } from 'vitest';
import {
  addressFromSpki,
  assertKeyTags,
  assertKmsEnvironment,
  kmsAliasFor,
} from '../src/modules/channels/kms/kms-address.js';
import { KmsKeyRejectedError, loadKmsSigner } from '../src/modules/channels/kms/kms-signer.js';
import { arnOf, fakeKms, spkiOf } from './fake-kms.js';

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

describe('KMS public key to Stellar address', () => {
  it('derives the G address from an Ed25519 SubjectPublicKeyInfo', () => {
    const key = randomKeypair();
    expect(addressFromSpki(spkiOf(key))).toBe(key.publicKey());
  });

  it('rejects a public key that is not Ed25519', () => {
    expect(() => addressFromSpki(Buffer.alloc(91))).toThrow(/Ed25519/);
  });

  it('rejects a 44-byte key with the wrong prefix as a key mismatch', async () => {
    const key = randomKeypair();
    const kms = fakeKms([key]);
    const client = {
      ...kms.client,
      getPublicKey: async (keyId: string) => ({
        ...(await kms.client.getPublicKey(keyId)),
        publicKey: Buffer.alloc(44, 1),
      }),
    };
    const result = loadKmsSigner(
      client,
      { role: 'channel', address: key.publicKey() },
      Networks.TESTNET,
    );
    await expect(result).rejects.toBeInstanceOf(KmsKeyRejectedError);
    await expect(result).rejects.toThrow(`alias/x402/channel/${key.publicKey()}`);
  });

  it('names the alias after the role and the address', () => {
    expect(kmsAliasFor({ role: 'fee-payer', address: 'GABC' })).toBe('alias/x402/fee-payer/GABC');
    expect(kmsAliasFor({ role: 'channel', address: 'GABC' })).toBe('alias/x402/channel/GABC');
  });

  it('names the upto authorization key facilitator, as Buyers know it', () => {
    expect(kmsAliasFor({ role: 'authorization', address: 'GABC' })).toBe(
      'alias/x402/facilitator/GABC',
    );
  });

  it.each(['devnet', 'testnet', 'pubnet-1'])('accepts the environment name %j', (name) => {
    expect(assertKmsEnvironment('--environment', name)).toBe(name);
  });

  it.each(['DevNet', 'dev_net', 'dev/net', ''])('rejects the environment name %j', (name) => {
    expect(() => assertKmsEnvironment('--environment', name)).toThrow(
      '--environment must contain only lowercase letters, digits and -',
    );
  });
});

describe('KMS key tag check', () => {
  const KEY = 'arn:aws:kms:us-west-1:111122223333:key/k1';
  const expected = {
    'x402:network': 'testnet',
    'x402:environment': 'devnet',
    'x402:role': 'channel',
  };
  const tags = (overrides: Record<string, string | undefined> = {}) =>
    Object.entries({ Project: 'facilitator', ...expected, ...overrides })
      .filter((entry): entry is [string, string] => entry[1] !== undefined)
      .map(([TagKey, TagValue]) => ({ TagKey, TagValue }));

  it('accepts a key whose network, environment and role tags match', () => {
    expect(() => assertKeyTags(KEY, tags(), expected)).not.toThrow();
  });

  it('rejects a key tagged for another environment', () => {
    expect(() => assertKeyTags(KEY, tags({ 'x402:environment': 'pubnet-1' }), expected)).toThrow(
      `${KEY} is tagged x402:environment=pubnet-1, not devnet`,
    );
  });

  it('rejects a key tagged for another role', () => {
    expect(() => assertKeyTags(KEY, tags({ 'x402:role': 'fee-payer' }), expected)).toThrow(
      `${KEY} is tagged x402:role=fee-payer, not channel`,
    );
  });

  it('rejects a key tagged for another network', () => {
    expect(() => assertKeyTags(KEY, tags({ 'x402:network': 'pubnet' }), expected)).toThrow(
      `${KEY} is tagged x402:network=pubnet, not testnet`,
    );
  });

  it('rejects a key missing a tag', () => {
    expect(() => assertKeyTags(KEY, tags({ 'x402:environment': undefined }), expected)).toThrow(
      `${KEY} has no x402:environment tag (expected devnet)`,
    );
  });

  it('names every mismatched tag at once', () => {
    const check = () =>
      assertKeyTags(KEY, tags({ 'x402:environment': 'prod', 'x402:role': undefined }), expected);
    expect(check).toThrow(/x402:environment=prod, not devnet/);
    expect(check).toThrow(/no x402:role tag \(expected channel\)/);
  });
});

describe('KMS signer', () => {
  it('signs transactions byte-identically to a local key', async () => {
    const key = randomKeypair();
    const signer = await loadKmsSigner(
      fakeKms([key]).client,
      { role: 'channel', address: key.publicKey() },
      Networks.TESTNET,
    );
    const local = createEd25519Signer(key.secret());
    const tx = unsignedTx(key.publicKey());
    expect((await signer.signTransaction(tx)).signedTxXdr).toBe(
      (await local.signTransaction(tx)).signedTxXdr,
    );
  });

  it('signs authorization entries byte-identically to a local key', async () => {
    const key = randomKeypair();
    const signer = await loadKmsSigner(
      fakeKms([key]).client,
      { role: 'channel', address: key.publicKey() },
      Networks.TESTNET,
    );
    const preimage = randomBytes(80).toString('base64');
    expect((await signer.signAuthEntry(preimage)).signedAuthEntry).toBe(
      (await createEd25519Signer(key.secret()).signAuthEntry(preimage)).signedAuthEntry,
    );
  });

  it('names its own address as the signer of every result, signed or failed', async () => {
    const key = randomKeypair();
    const address = key.publicKey();
    const ref = { role: 'channel' as const, address };
    const signer = await loadKmsSigner(fakeKms([key]).client, ref, Networks.TESTNET);
    const failing = await loadKmsSigner(
      fakeKms([key], { signError: new Error('ThrottlingException') }).client,
      ref,
      Networks.TESTNET,
    );
    const preimage = randomBytes(80).toString('base64');

    for (const each of [signer, failing]) {
      expect((await each.signTransaction(unsignedTx(address))).signerAddress).toBe(address);
      expect((await each.signAuthEntry(preimage)).signerAddress).toBe(address);
    }
  });

  it('looks the key up by alias and signs by ARN', async () => {
    const key = randomKeypair();
    const kms = fakeKms([key]);
    const signer = await loadKmsSigner(
      kms.client,
      { role: 'channel', address: key.publicKey() },
      Networks.TESTNET,
    );
    await signer.signTransaction(unsignedTx(key.publicKey()));
    expect(kms.calls).toEqual([
      { op: 'getPublicKey', keyId: `alias/x402/channel/${key.publicKey()}` },
      { op: 'sign', keyId: arnOf(key) },
    ]);
    expect(signer.keyArn).toBe(arnOf(key));
  });

  it('rejects an alias that points at another key', async () => {
    const expected = randomKeypair();
    const kms = fakeKms([], {
      aliasTo: { [expected.publicKey()]: randomKeypair() },
    });
    await expect(
      loadKmsSigner(
        kms.client,
        { role: 'channel', address: expected.publicKey() },
        Networks.TESTNET,
      ),
    ).rejects.toBeInstanceOf(KmsKeyRejectedError);
  });

  it('rejects a key that is not an Ed25519 signing key', async () => {
    const key = randomKeypair();
    const kms = fakeKms([key], { keySpec: 'ECC_NIST_P256' });
    await expect(
      loadKmsSigner(kms.client, { role: 'channel', address: key.publicKey() }, Networks.TESTNET),
    ).rejects.toThrow(/ECC_NIST_EDWARDS25519/);
  });

  it('reports, never returns, a signature that does not verify', async () => {
    const key = randomKeypair();
    const signer = await loadKmsSigner(
      fakeKms([key], { badSignature: true }).client,
      { role: 'channel', address: key.publicKey() },
      Networks.TESTNET,
    );
    const result = await signer.signTransaction(unsignedTx(key.publicKey()));
    expect(result.signedTxXdr).toBe('');
    expect(result.error?.message).toMatch(/does not verify/);
  });

  it('reports a bad signature on an authorization entry', async () => {
    const key = randomKeypair();
    const signer = await loadKmsSigner(
      fakeKms([key], { badSignature: true }).client,
      { role: 'channel', address: key.publicKey() },
      Networks.TESTNET,
    );
    const result = await signer.signAuthEntry(randomBytes(80).toString('base64'));
    expect(result.signedAuthEntry).toBe('');
    expect(result.error?.message).toMatch(/does not verify/);
  });

  it('returns, never throws, when KMS sign rejects', async () => {
    const key = randomKeypair();
    const signer = await loadKmsSigner(
      fakeKms([key], { signError: new Error('ThrottlingException') }).client,
      { role: 'channel', address: key.publicKey() },
      Networks.TESTNET,
    );
    const tx = await signer.signTransaction(unsignedTx(key.publicKey()));
    expect(tx.signedTxXdr).toBe('');
    expect(tx.error?.message).toMatch(/ThrottlingException/);
    const entry = await signer.signAuthEntry(randomBytes(80).toString('base64'));
    expect(entry.signedAuthEntry).toBe('');
    expect(entry.error?.message).toMatch(/ThrottlingException/);
  });

  it('logs why signing failed without payloads or signatures', async () => {
    const key = randomKeypair();
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const signer = await loadKmsSigner(
      fakeKms([key], { signError: new Error('ThrottlingException') }).client,
      { role: 'channel', address: key.publicKey() },
      Networks.TESTNET,
      log,
    );
    const xdr = unsignedTx(key.publicKey());
    const preimage = randomBytes(80).toString('base64');
    await signer.signTransaction(xdr);
    await signer.signAuthEntry(preimage);
    const expected = {
      address: key.publicKey(),
      keyArn: arnOf(key),
      errorName: 'Error',
      errorMessage: 'ThrottlingException',
    };
    expect(log.warn).toHaveBeenCalledTimes(2);
    expect(log.warn).toHaveBeenNthCalledWith(1, 'kms_sign_failed', expected);
    expect(log.warn).toHaveBeenNthCalledWith(2, 'kms_sign_failed', expected);
    expect(JSON.stringify(log.warn.mock.calls)).not.toContain(xdr);
    expect(JSON.stringify(log.warn.mock.calls)).not.toContain(preimage);
  });

  it('rejects a key whose usage is not SIGN_VERIFY', async () => {
    const key = randomKeypair();
    const kms = fakeKms([key], { keyUsage: 'ENCRYPT_DECRYPT' });
    await expect(
      loadKmsSigner(kms.client, { role: 'channel', address: key.publicKey() }, Networks.TESTNET),
    ).rejects.toBeInstanceOf(KmsKeyRejectedError);
  });

  it('returns an error for malformed transaction XDR', async () => {
    const key = randomKeypair();
    const signer = await loadKmsSigner(
      fakeKms([key]).client,
      { role: 'channel', address: key.publicKey() },
      Networks.TESTNET,
    );
    const result = await signer.signTransaction('not-xdr');
    expect(result.signedTxXdr).toBe('');
    expect(result.error).toBeDefined();
  });
});
