import { Keypair, StrKey } from '@stellar/stellar-sdk';
import { x402Client } from '@x402/core/client';
import type { PaymentRequired, PaymentRequirements } from '@x402/core/types';
import { ExactStellarScheme } from '@x402/stellar/exact/client';
import { getUsdcAddress } from '@x402/stellar';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEd25519Signer, UptoStellarClient } from '../../src/buyer.js';
import { createPaymentClient } from '../../src/buyer/payment-client.js';
import type { PaymentClientConfig } from '../../src/buyer/payment-client.js';

const network = 'stellar:testnet';
const asset = StrKey.encodeContract(Buffer.alloc(32, 10));
const payTo = StrKey.encodeEd25519PublicKey(Buffer.alloc(32, 11));
const signer = createEd25519Signer(Keypair.random().secret(), network);
const amount = '900719925474099312345';
const base = {
  scheme: 'exact',
  network,
  asset,
  payTo,
  amount,
  maxTimeoutSeconds: 60,
  extra: { areFeesSponsored: true },
} satisfies PaymentRequirements;
const config = { network, signer } satisfies PaymentClientConfig;

function challenge(...accepts: PaymentRequirements[]): PaymentRequired {
  return {
    x402Version: 2,
    resource: {
      url: 'https://seller.example.com/weather',
      description: 'Weather',
      mimeType: 'application/json',
    },
    accepts,
  };
}

function signingBoundary(scheme = 'exact') {
  const prototype = scheme === 'exact' ? ExactStellarScheme.prototype : UptoStellarClient.prototype;
  return vi
    .spyOn(prototype, 'createPaymentPayload')
    .mockResolvedValue({ x402Version: 2, payload: { transaction: 'signed-transaction-xdr' } });
}

afterEach(() => vi.restoreAllMocks());

describe('native Buyer payment client', () => {
  it.each(['stellar:testnet', 'stellar:pubnet'] as const)(
    'configures a native exact client for %s without a token list',
    async (network) => {
      const createPayload = signingBoundary();
      const buyer = createPaymentClient({ ...config, network });
      expect(Object.getPrototypeOf(buyer)).toBe(x402Client.prototype);
      expect(createPayload).not.toHaveBeenCalled();
      const requirement = { ...base, network };
      const payload = await buyer.createPaymentPayload(challenge(requirement));
      expect(payload).toMatchObject({
        x402Version: 2,
        accepted: requirement,
        payload: { transaction: 'signed-transaction-xdr' },
      });
      expect(createPayload).toHaveBeenCalledOnce();
    },
  );

  it.each(['exact', 'upto'])(
    'accepts arbitrary token contracts and large atomic amounts with %s',
    async (scheme) => {
      const createPayload = signingBoundary(scheme);
      const buyer = createPaymentClient(config);
      for (const token of [asset, StrKey.encodeContract(Buffer.alloc(32, 12))]) {
        const requirement = { ...base, scheme, asset: token };
        const payload = await buyer.createPaymentPayload(challenge(requirement));
        expect(payload.accepted).toEqual(requirement);
      }
      expect(createPayload).toHaveBeenCalledTimes(2);
      expect(createPayload.mock.calls[0]?.[1].amount).toBe(amount);
    },
  );

  it.each(['exact', 'upto'])(
    'does not apply an implicit USD cap to default tokens with %s',
    async (scheme) => {
      const createPayload = signingBoundary(scheme);
      await createPaymentClient(config).createPaymentPayload(
        challenge({ ...base, scheme, asset: getUsdcAddress(network), amount: '200000000' }),
      );
      expect(createPayload).toHaveBeenCalledOnce();
    },
  );

  it.each(['exact', 'upto'])('allows callers to register only %s', async (scheme) => {
    const exact = signingBoundary();
    const upto = signingBoundary('upto');
    const buyer = createPaymentClient({ ...config, schemes: [scheme] });
    await buyer.createPaymentPayload(challenge({ ...base, scheme }));
    await expect(
      buyer.createPaymentPayload(
        challenge({ ...base, scheme: scheme === 'exact' ? 'upto' : 'exact' }),
      ),
    ).rejects.toThrow();
    expect(scheme === 'exact' ? exact : upto).toHaveBeenCalledOnce();
    expect(scheme === 'exact' ? upto : exact).not.toHaveBeenCalled();
  });

  it.each([{ schemes: [] }, { schemes: ['exact', 'exact'] }, { schemes: ['escrow'] }])(
    'rejects invalid scheme registration $schemes',
    ({ schemes }) => {
      expect(() => createPaymentClient({ ...config, schemes })).toThrow(TypeError);
    },
  );

  it('preserves the signed i128 maximum without number conversion', async () => {
    const createPayload = signingBoundary();
    const maximum = ((1n << 127n) - 1n).toString();
    await createPaymentClient(config).createPaymentPayload(challenge({ ...base, amount: maximum }));
    expect(createPayload.mock.calls[0]?.[1].amount).toBe(maximum);
  });

  it('selects the first valid registered quote without a token preference', async () => {
    signingBoundary();
    const first = { ...base, asset: StrKey.encodeContract(Buffer.alloc(32, 14)) };
    const payload = await createPaymentClient(config).createPaymentPayload(
      challenge({ ...base, asset: 'not-a-contract' }, first, { ...base, amount: '1' }),
    );
    expect(payload.accepted).toEqual(first);
  });

  it.each([
    { name: 'another network', requirement: { ...base, network: 'stellar:pubnet' as const } },
    { name: 'an unregistered scheme', requirement: { ...base, scheme: 'escrow' } },
    { name: 'a token symbol instead of a contract', requirement: { ...base, asset: 'USDC' } },
  ])('does not sign $name requirements', async ({ requirement }) => {
    const createPayload = signingBoundary();
    await expect(
      createPaymentClient(config).createPaymentPayload(challenge(requirement)),
    ).rejects.toThrow();
    expect(createPayload).not.toHaveBeenCalled();
  });

  it.each(['0', '-1', '1.5', '1e3', ' 1', '001', (1n << 127n).toString()])(
    'does not sign malformed or out-of-range amount %s',
    async (amount) => {
      const createPayload = signingBoundary();
      await expect(
        createPaymentClient(config).createPaymentPayload(challenge({ ...base, amount })),
      ).rejects.toThrow();
      expect(createPayload).not.toHaveBeenCalled();
    },
  );

  it('allows an application to add its own native spending policy', async () => {
    const createPayload = signingBoundary();
    const buyer = createPaymentClient(config).registerPolicy((_version, requirements) =>
      requirements.filter((requirement) => BigInt(requirement.amount) <= 2n),
    );
    await expect(buyer.createPaymentPayload(challenge({ ...base, amount: '3' }))).rejects.toThrow();
    await buyer.createPaymentPayload(challenge({ ...base, amount: '2' }));
    expect(createPayload).toHaveBeenCalledOnce();
  });

  it('keeps native approval hooks available before signing', async () => {
    const createPayload = signingBoundary();
    const approve = vi.fn().mockResolvedValue({ abort: true, reason: 'Wallet declined' });
    const buyer = createPaymentClient(config).onBeforePaymentCreation(approve);
    await expect(buyer.createPaymentPayload(challenge(base))).rejects.toThrow(/Wallet declined/);
    expect(approve).toHaveBeenCalledOnce();
    expect(approve.mock.calls[0]?.[0].selectedRequirements).toEqual(base);
    expect(createPayload).not.toHaveBeenCalled();
  });

  it('rejects a non-Stellar network at setup', () => {
    expect(() => createPaymentClient({ ...config, network: 'eip155:1' })).toThrow(TypeError);
  });

  it('rejects a signer with an unsupported account address at setup', () => {
    expect(() =>
      createPaymentClient({ ...config, signer: { ...signer, address: 'invalid' } }),
    ).toThrow(TypeError);
  });
});
