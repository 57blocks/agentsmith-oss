import { StrKey } from '@stellar/stellar-sdk';
import { ExactStellarScheme } from '@x402/stellar/exact/server';
import { HTTPFacilitatorClient, x402ResourceServer } from '@x402/core/server';
import { VerifyError, SettleError } from '@x402/core/types';
import { FacilitatorTimeoutError } from '@x402/core/server';
import type { SupportedKind, SupportedResponse } from '@x402/core/types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createResourceServer,
  ResourceServerInitializationError,
  UptoStellarServer,
} from '../../src/seller.js';
import type { ResourceServerConfig } from '../../src/seller.js';

const API_KEY = 'test-private-key';
const supported: SupportedResponse = {
  kinds: [
    {
      x402Version: 2,
      scheme: 'exact',
      network: 'stellar:testnet',
      extra: { areFeesSponsored: true },
    },
  ],
  extensions: [],
  signers: { 'stellar:*': [StrKey.encodeEd25519PublicKey(Buffer.alloc(32, 9))] },
};

const uptoKind: SupportedKind = {
  x402Version: 2,
  scheme: 'upto',
  network: 'stellar:testnet',
  extra: {
    settlementContract: StrKey.encodeContract(Buffer.alloc(32, 7)),
    facilitator: StrKey.encodeEd25519PublicKey(Buffer.alloc(32, 8)),
    areFeesSponsored: true,
  },
};
const both: SupportedResponse = { ...supported, kinds: [...supported.kinds, uptoKind] };

function fixture(response = supported) {
  const client = {
    getSupported: vi
      .spyOn(HTTPFacilitatorClient.prototype, 'getSupported')
      .mockResolvedValue(response),
    verify: vi
      .spyOn(HTTPFacilitatorClient.prototype, 'verify')
      .mockResolvedValue({ isValid: true }),
    settle: vi
      .spyOn(HTTPFacilitatorClient.prototype, 'settle')
      .mockResolvedValue({ success: true, transaction: 'hash', network: 'stellar:testnet' }),
  };
  const config: ResourceServerConfig = {
    facilitator: { url: 'https://facilitator.example.com/facilitator' },
    network: 'stellar:testnet',
  };
  return { client, config };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('native resource server setup', () => {
  it('returns an initialized native server with upstream exact registered', async () => {
    const { config, client } = fixture();
    const server = await createResourceServer(config);
    expect(server).toBeInstanceOf(x402ResourceServer);
    expect(server.getRegisteredScheme(config.network, 'exact')).toBeInstanceOf(ExactStellarScheme);
    expect(server.getSupportedKind(2, config.network, 'exact')).toEqual(supported.kinds[0]);
    expect(client.getSupported).toHaveBeenCalledOnce();
  });
  it('supports pubnet when the facilitator advertises it', async () => {
    const { config } = fixture({
      ...supported,
      kinds: [{ ...supported.kinds[0]!, network: 'stellar:pubnet' as const }],
    });
    config.network = 'stellar:pubnet';
    config.facilitator.apiKey = API_KEY;
    const server = await createResourceServer(config);
    expect(server.getRegisteredScheme('stellar:pubnet', 'exact')).toBeInstanceOf(
      ExactStellarScheme,
    );
  });
  it('authenticates pubnet capability discovery through the official HTTP client', async () => {
    const pubnetSupported = {
      ...supported,
      kinds: [{ ...supported.kinds[0]!, network: 'stellar:pubnet' as const }],
    };
    const { config } = fixture(pubnetSupported);
    config.network = 'stellar:pubnet';
    config.facilitator.apiKey = API_KEY;
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(pubnetSupported));
    vi.stubGlobal('fetch', fetcher);
    vi.mocked(HTTPFacilitatorClient.prototype.getSupported).mockRestore();
    config.facilitator.url += '///';
    await createResourceServer(config);
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, request] = fetcher.mock.calls[0]!;
    expect(url).toBe('https://facilitator.example.com/facilitator/supported');
    expect(request?.method).toBe('GET');
    expect(new Headers(request?.headers).get('Authorization')).toBe(`Bearer ${API_KEY}`);
  });
  it('omits testnet authorization without an API key', async () => {
    const { config } = fixture();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(supported));
    vi.stubGlobal('fetch', fetcher);
    vi.mocked(HTTPFacilitatorClient.prototype.getSupported).mockRestore();
    await createResourceServer(config);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(new Headers(fetcher.mock.calls[0]![1]?.headers).get('Authorization')).toBeNull();
  });
  it('sends a supplied testnet API key so the Facilitator can check it', async () => {
    const { config } = fixture();
    config.facilitator.apiKey = API_KEY;
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(supported));
    vi.stubGlobal('fetch', fetcher);
    vi.mocked(HTTPFacilitatorClient.prototype.getSupported).mockRestore();
    await createResourceServer(config);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(new Headers(fetcher.mock.calls[0]![1]?.headers).get('Authorization')).toBe(
      `Bearer ${API_KEY}`,
    );
  });
  it.each([
    { reason: 'empty', apiKey: '' },
    { reason: 'blank', apiKey: ' ' },
    { reason: 'invalid header characters in', apiKey: 'key\nheader' },
  ])('rejects $reason testnet credentials before discovery', async ({ apiKey }) => {
    const { config, client } = fixture();
    config.facilitator.apiKey = apiKey;
    await expect(createResourceServer(config)).rejects.toThrow(TypeError);
    expect(client.getSupported).not.toHaveBeenCalled();
  });
  it('registers exact and upto when both schemes are selected', async () => {
    const { config } = fixture(both);
    config.schemes = ['exact', 'upto'];
    const server = await createResourceServer(config);
    expect(server.getRegisteredScheme(config.network, 'upto')).toBeInstanceOf(UptoStellarServer);
    expect(server.getRegisteredScheme(config.network, 'exact')).toBeInstanceOf(ExactStellarScheme);
  });
  it('enables only upto without requiring exact capability', async () => {
    const { config } = fixture({ ...supported, kinds: [uptoKind] });
    config.schemes = ['upto'];
    const server = await createResourceServer(config);
    expect(server.getRegisteredScheme(config.network, 'upto')).toBeInstanceOf(UptoStellarServer);
    expect(server.hasRegisteredScheme(config.network, 'exact')).toBe(false);
  });
  it('registers upto on pubnet when advertised', async () => {
    const { config } = fixture({
      ...supported,
      kinds: [{ ...uptoKind, network: 'stellar:pubnet' }],
    });
    config.network = 'stellar:pubnet';
    config.facilitator.apiKey = API_KEY;
    config.schemes = ['upto'];
    const server = await createResourceServer(config);
    expect(server.getRegisteredScheme('stellar:pubnet', 'upto')).toBeInstanceOf(UptoStellarServer);
  });
  it('merges price and route metadata with advertised upto terms', async () => {
    const { config } = fixture(both);
    config.schemes = ['upto'];
    const server = await createResourceServer(config);
    const requirements = await server.buildPaymentRequirements({
      scheme: 'upto',
      network: config.network,
      payTo: StrKey.encodeEd25519PublicKey(Buffer.alloc(32, 11)),
      price: {
        asset: StrKey.encodeContract(Buffer.alloc(32, 10)),
        amount: '10000',
        extra: { priceLabel: 'quote', shared: 'price' },
      },
      extra: { routeLabel: 'route', shared: 'route' },
      maxTimeoutSeconds: 60,
    });
    expect(requirements).toHaveLength(1);
    expect(requirements[0]?.extra).toEqual({
      priceLabel: 'quote',
      routeLabel: 'route',
      shared: 'route',
      ...uptoKind.extra,
    });
  });
  it('preserves a non-USDC asset and large atomic amount in native requirements', async () => {
    const { config } = fixture(both);
    config.schemes = ['upto'];
    const server = await createResourceServer(config);
    const asset = StrKey.encodeContract(Buffer.alloc(32, 10));
    const amount = '900719925474099312345';
    const requirements = await server.buildPaymentRequirements({
      scheme: 'upto',
      network: config.network,
      payTo: StrKey.encodeEd25519PublicKey(Buffer.alloc(32, 11)),
      price: { asset, amount },
      maxTimeoutSeconds: 60,
    });
    expect(requirements).toHaveLength(1);
    expect(requirements[0]).toMatchObject({ asset, amount });
  });
  it('does not verify or settle payments during setup or requirement construction', async () => {
    const { config, client } = fixture(both);
    config.schemes = ['exact', 'upto'];
    const server = await createResourceServer(config);
    expect(client.verify).not.toHaveBeenCalled();
    expect(client.settle).not.toHaveBeenCalled();
    for (const scheme of config.schemes) {
      await server.buildPaymentRequirements({
        scheme,
        network: config.network,
        payTo: StrKey.encodeEd25519PublicKey(Buffer.alloc(32, 11)),
        price: { asset: StrKey.encodeContract(Buffer.alloc(32, 10)), amount: '10000' },
        maxTimeoutSeconds: 60,
      });
    }
    expect(client.verify).not.toHaveBeenCalled();
    expect(client.settle).not.toHaveBeenCalled();
  });
  it('rejects setup when the selected upto scheme is not advertised', async () => {
    const { config } = fixture();
    config.schemes = ['upto'];
    await expect(createResourceServer(config)).rejects.toThrow(/does not support/);
  });
  it.each([
    { reason: 'missing metadata', extra: undefined },
    { reason: 'empty metadata', extra: {} },
    {
      reason: 'invalid Kernel address',
      extra: { ...uptoKind.extra, settlementContract: 'invalid' },
    },
    {
      reason: 'invalid authorization address',
      extra: { ...uptoKind.extra, facilitator: 'invalid' },
    },
    {
      reason: 'contract Facilitator source',
      extra: { ...uptoKind.extra, facilitator: StrKey.encodeContract(Buffer.alloc(32, 6)) },
    },
    {
      reason: 'missing sponsorship flag',
      extra: { ...uptoKind.extra, areFeesSponsored: undefined },
    },
    {
      reason: 'non-boolean sponsorship flag',
      extra: { ...uptoKind.extra, areFeesSponsored: 'true' },
    },
  ])('rejects upto $reason at initialization', async ({ extra }) => {
    const { config } = fixture({ ...supported, kinds: [{ ...uptoKind, extra }] });
    config.schemes = ['upto'];
    await expect(createResourceServer(config)).rejects.toThrow(/valid upto/);
  });
  it.each([
    { reason: 'no advertised schemes', kinds: [], error: ResourceServerInitializationError },
    {
      reason: 'a different network',
      error: TypeError,
      kinds: [{ ...supported.kinds[0]!, network: 'stellar:pubnet' as const }],
    },
    {
      reason: 'x402 v1 only',
      kinds: [{ ...supported.kinds[0]!, x402Version: 1 }],
      error: TypeError,
    },
  ])('rejects setup with $reason', async ({ kinds, error }) => {
    await expect(createResourceServer(fixture({ ...supported, kinds }).config)).rejects.toThrow(
      error,
    );
  });
  it('sanitizes an upstream initialization failure', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { config, client } = fixture();
    vi.mocked(client.getSupported).mockRejectedValue(new Error(API_KEY));
    const error = await createResourceServer(config).catch((value: unknown) => value);
    expect(error).toBeInstanceOf(ResourceServerInitializationError);
    expect(String(error)).not.toContain(API_KEY);
    expect(JSON.stringify(error)).not.toContain(API_KEY);
    expect(JSON.stringify(warn.mock.calls)).not.toContain(API_KEY);
  });
});

describe('setup validation', () => {
  it.each([
    '',
    'bad-url',
    'file:///tmp/token',
    'https://user:secret@example.com',
    'https://example.com?key=secret',
    'https://example.com#secret',
  ])('rejects invalid URL %s before discovery', async (url) => {
    const { config, client } = fixture();
    config.facilitator.url = url;
    await expect(createResourceServer(config)).rejects.toThrow(TypeError);
    expect(client.getSupported).not.toHaveBeenCalled();
  });
  it.each([
    { reason: 'missing', apiKey: undefined },
    { reason: 'empty', apiKey: '' },
    { reason: 'blank', apiKey: ' ' },
    { reason: 'invalid header characters in', apiKey: 'key\nheader' },
  ])('rejects $reason pubnet credentials before discovery', async ({ apiKey }) => {
    const { config, client } = fixture();
    config.network = 'stellar:pubnet';
    config.facilitator.apiKey = apiKey;
    await expect(createResourceServer(config)).rejects.toThrow(TypeError);
    expect(client.getSupported).not.toHaveBeenCalled();
  });
  it.each([0, -1, 0.5, Infinity, NaN, 2_147_483_648])(
    'rejects invalid timeout %s',
    async (timeoutMs) => {
      const { config, client } = fixture();
      config.facilitator.timeoutMs = timeoutMs;
      await expect(createResourceServer(config)).rejects.toThrow(TypeError);
      expect(client.getSupported).not.toHaveBeenCalled();
    },
  );
  it('rejects unsupported networks before discovery', async () => {
    const { config, client } = fixture();
    await expect(createResourceServer({ ...config, network: 'eip155:1' })).rejects.toThrow(
      TypeError,
    );
    expect(client.getSupported).not.toHaveBeenCalled();
  });
  it.each([
    { reason: 'empty', schemes: [] },
    { reason: 'duplicate', schemes: ['exact', 'exact'] },
  ])('rejects $reason scheme names before discovery', async ({ schemes }) => {
    const { config, client } = fixture();
    config.schemes = schemes;
    await expect(createResourceServer(config)).rejects.toThrow(TypeError);
    expect(client.getSupported).not.toHaveBeenCalled();
  });
  it('rejects unsupported scheme names before discovery', async () => {
    const { config, client } = fixture();
    config.schemes = ['escrow'];
    await expect(createResourceServer(config)).rejects.toThrow(TypeError);
    expect(client.getSupported).not.toHaveBeenCalled();
  });
});

describe('native Facilitator failure semantics', () => {
  it.each(['verify', 'settle', 'timeout'] as const)(
    'preserves the native %s failure for framework hooks',
    async (kind) => {
      const { config, client } = fixture();
      const server = await createResourceServer(config);
      const [requirement] = await server.buildPaymentRequirements({
        scheme: 'exact',
        network: config.network,
        payTo: StrKey.encodeEd25519PublicKey(Buffer.alloc(32, 11)),
        price: { asset: StrKey.encodeContract(Buffer.alloc(32, 10)), amount: '10000' },
      });
      if (!requirement) throw new Error('Missing requirement');
      const payment = { x402Version: 2, accepted: requirement, payload: { transaction: 'test' } };
      const error =
        kind === 'verify'
          ? new VerifyError(402, { isValid: false, invalidReason: 'invalid_signature' })
          : kind === 'settle'
            ? new SettleError(402, {
                success: false,
                errorReason: 'insufficient_funds',
                transaction: '',
                network: config.network,
              })
            : new FacilitatorTimeoutError('verify', 100);
      if (kind === 'settle') {
        client.settle.mockRejectedValue(error);
        await expect(server.settlePayment(payment, requirement)).rejects.toBe(error);
      } else {
        client.verify.mockRejectedValue(error);
        const failure = await server
          .verifyPayment(payment, requirement)
          .catch((value: unknown) => value);
        if (kind === 'timeout') {
          expect(failure).toBeInstanceOf(FacilitatorTimeoutError);
          expect(failure).toMatchObject({
            operation: 'verify',
            timeoutMs: 100,
            message: 'Facilitator verify request timed out after 100ms',
          });
        } else {
          expect(failure).toBe(error);
        }
      }
    },
  );
});
