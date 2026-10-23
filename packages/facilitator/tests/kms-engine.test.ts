import { randomBytes } from 'node:crypto';
import { Keypair } from '@stellar/stellar-sdk';
import { describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config/facilitator.config.js';
import { createStellarPaymentEngine } from '../src/modules/x402/services/engine/payment-engine.js';
import { arnOf, fakeKms } from './fake-kms.js';
import { fakeChannelPool } from './fake-lease-store.js';
import { TEST_DATABASE_URL } from './test-env.js';
import { journalWithoutDatabase } from './test-journal.js';

const randomKeypair = () => Keypair.fromRawEd25519Seed(randomBytes(32));
const silent = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() });

function kmsConfig(feePayer: Keypair, channels: Keypair[], authorization?: Keypair) {
  return loadConfig({
    DATABASE_URL: TEST_DATABASE_URL,
    CHANNEL_STORE_URL: 'redis://127.0.0.1:6379',
    FACILITATOR_API_KEY: 'test-only-token',
    FACILITATOR_SIGNING_MODE: 'kms',
    FACILITATOR_KMS_REGION: 'us-west-1',
    FACILITATOR_KMS_FEE_PAYER_ADDRESS: feePayer.publicKey(),
    FACILITATOR_KMS_CHANNEL_ADDRESSES: channels.map((c) => c.publicKey()).join(','),
    ...(authorization
      ? {
          FACILITATOR_KMS_AUTHORIZATION_ADDRESS: authorization.publicKey(),
          X402_UPTO_KERNEL_CONTRACT: randomKeypair().publicKey(),
        }
      : {}),
  });
}

describe('payment engine in kms mode', () => {
  it('advertises the KMS authorization key as the only signer and in extra', async () => {
    const [feePayer, channel, authorization] = [randomKeypair(), randomKeypair(), randomKeypair()];
    const kms = fakeKms([feePayer, channel, authorization]);
    const engine = await createStellarPaymentEngine(
      kmsConfig(feePayer, [channel], authorization),
      silent(),
      {
        kms: kms.client,
        pool: fakeChannelPool([]).pool,
        journal: journalWithoutDatabase(),
      },
    );
    const supported = engine.supported();
    expect(supported.kinds.find((k) => k.scheme === 'upto')?.extra?.facilitator).toBe(
      authorization.publicKey(),
    );
    expect(supported.signers['stellar:*']).toEqual([authorization.publicKey()]);
  });

  it('loads no channel key at startup: channels load in the pool, per lease', async () => {
    const [feePayer, channel] = [randomKeypair(), randomKeypair()];
    const kms = fakeKms([feePayer]);
    await createStellarPaymentEngine(kmsConfig(feePayer, [channel]), silent(), {
      kms: kms.client,
      pool: fakeChannelPool([]).pool,
      journal: journalWithoutDatabase(),
    });
    expect(kms.calls).not.toContainEqual(
      expect.objectContaining({ keyId: `alias/x402/channel/${channel.publicKey()}` }),
    );
  });

  it('logs the address to key ARN mapping of the fee payer and authorization keys', async () => {
    const [feePayer, channel, authorization] = [randomKeypair(), randomKeypair(), randomKeypair()];
    const kms = fakeKms([feePayer, channel, authorization]);
    const log = silent();
    await createStellarPaymentEngine(kmsConfig(feePayer, [channel], authorization), log, {
      kms: kms.client,
      pool: fakeChannelPool([]).pool,
      journal: journalWithoutDatabase(),
    });
    for (const [role, key] of [
      ['fee_payer', feePayer],
      ['authorization', authorization],
    ] as const) {
      expect(log.info).toHaveBeenCalledWith('kms_signer_loaded', {
        role,
        address: key.publicKey(),
        keyArn: arnOf(key),
      });
    }
  });

  it('looks each address up under the alias of its configured role', async () => {
    const [feePayer, channel, authorization] = [randomKeypair(), randomKeypair(), randomKeypair()];
    const kms = fakeKms([feePayer, channel, authorization]);
    await createStellarPaymentEngine(kmsConfig(feePayer, [channel], authorization), silent(), {
      kms: kms.client,
      pool: fakeChannelPool([]).pool,
      journal: journalWithoutDatabase(),
    });
    expect(kms.calls.filter((call) => call.op === 'getPublicKey')).toEqual(
      expect.arrayContaining([
        { op: 'getPublicKey', keyId: `alias/x402/fee-payer/${feePayer.publicKey()}` },
        { op: 'getPublicKey', keyId: `alias/x402/facilitator/${authorization.publicKey()}` },
      ]),
    );
  });

  it('refuses to start when the fee payer key does not match', async () => {
    const [feePayer, channel] = [randomKeypair(), randomKeypair()];
    const kms = fakeKms([channel], {
      aliasTo: { [feePayer.publicKey()]: randomKeypair() },
    });
    const log = silent();
    await expect(
      createStellarPaymentEngine(kmsConfig(feePayer, [channel]), log, {
        kms: kms.client,
        pool: fakeChannelPool([]).pool,
        journal: journalWithoutDatabase(),
      }),
    ).rejects.toThrow(/resolves to/);
    expect(log.error).toHaveBeenCalledWith(
      'kms_signer_rejected',
      expect.objectContaining({
        role: 'fee_payer',
        address: feePayer.publicKey(),
        reason: 'key_mismatch',
      }),
    );
  });

  it('refuses to start when the authorization key does not match', async () => {
    const [feePayer, channel, authorization] = [randomKeypair(), randomKeypair(), randomKeypair()];
    const kms = fakeKms([feePayer, channel], {
      aliasTo: { [authorization.publicKey()]: randomKeypair() },
    });
    const log = silent();
    await expect(
      createStellarPaymentEngine(kmsConfig(feePayer, [channel], authorization), log, {
        kms: kms.client,
        pool: fakeChannelPool([]).pool,
        journal: journalWithoutDatabase(),
      }),
    ).rejects.toThrow(/resolves to/);
    expect(log.error).toHaveBeenCalledWith(
      'kms_signer_rejected',
      expect.objectContaining({ role: 'authorization', address: authorization.publicKey() }),
    );
  });

  it('logs an unavailable fee payer key before refusing to start', async () => {
    const [feePayer, channel] = [randomKeypair(), randomKeypair()];
    const kms = fakeKms([channel]);
    const log = silent();
    await expect(
      createStellarPaymentEngine(kmsConfig(feePayer, [channel]), log, {
        kms: kms.client,
        pool: fakeChannelPool([]).pool,
        journal: journalWithoutDatabase(),
      }),
    ).rejects.toThrow(/NotFound/);
    expect(log.error).toHaveBeenCalledWith(
      'kms_signer_unavailable',
      expect.objectContaining({ role: 'fee_payer', reason: 'kms_error' }),
    );
  });

  it('refuses a fee payer that is also a channel', async () => {
    const feePayer = randomKeypair();
    const kms = fakeKms([feePayer]);
    await expect(
      createStellarPaymentEngine(kmsConfig(feePayer, [feePayer]), silent(), {
        kms: kms.client,
        pool: fakeChannelPool([]).pool,
        journal: journalWithoutDatabase(),
      }),
    ).rejects.toThrow(/separate/);
  });

  it('refuses duplicate channel addresses', async () => {
    const [feePayer, channel] = [randomKeypair(), randomKeypair()];
    const kms = fakeKms([feePayer, channel]);
    await expect(
      createStellarPaymentEngine(kmsConfig(feePayer, [channel, channel]), silent(), {
        kms: kms.client,
        pool: fakeChannelPool([]).pool,
        journal: journalWithoutDatabase(),
      }),
    ).rejects.toThrow(/duplicate/);
  });

  it('refuses an authorization key that is also a channel', async () => {
    const [feePayer, channel] = [randomKeypair(), randomKeypair()];
    const kms = fakeKms([feePayer, channel]);
    await expect(
      createStellarPaymentEngine(kmsConfig(feePayer, [channel], channel), silent(), {
        kms: kms.client,
        pool: fakeChannelPool([]).pool,
        journal: journalWithoutDatabase(),
      }),
    ).rejects.toThrow(/separate/);
  });
});
