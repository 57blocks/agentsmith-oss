import { StrKey } from '@stellar/stellar-sdk';
import type { PaymentRequirements, SupportedKind } from '@x402/core/types';
import { describe, expect, it } from 'vitest';
import { UptoStellarServer } from '../../src/seller.js';

const kernel = StrKey.encodeContract(Buffer.alloc(32, 1));
const facilitator = StrKey.encodeEd25519PublicKey(Buffer.alloc(32, 2));
const supported: SupportedKind = {
  x402Version: 2,
  scheme: 'upto',
  network: 'stellar:testnet',
  extra: { settlementContract: kernel, facilitator, areFeesSponsored: true },
};
const requirements: PaymentRequirements = {
  scheme: 'upto',
  network: 'stellar:testnet',
  asset: StrKey.encodeContract(Buffer.alloc(32, 3)),
  payTo: StrKey.encodeEd25519PublicKey(Buffer.alloc(32, 4)),
  amount: '10000',
  maxTimeoutSeconds: 60,
  extra: { label: 'custom-route-metadata' },
};

describe('upto payment requirements', () => {
  it('adds advertised metadata and preserves route-specific fields', async () => {
    const adapter = new UptoStellarServer();
    const result = await adapter.enhancePaymentRequirements(requirements, supported, []);
    expect(result).toEqual({
      ...requirements,
      extra: { ...requirements.extra, ...supported.extra },
    });
  });
  it('preserves disabled fee sponsorship', async () => {
    const result = await new UptoStellarServer().enhancePaymentRequirements(
      requirements,
      { ...supported, extra: { ...supported.extra, areFeesSponsored: false } },
      [],
    );
    expect(result.extra.areFeesSponsored).toBe(false);
  });
  it('preserves an explicit SEP-41 asset and large atomic price', async () => {
    const adapter = new UptoStellarServer();
    const price = { asset: requirements.asset, amount: '900719925474099312345' };
    expect(await adapter.parsePrice(price, requirements.network)).toEqual({ ...price, extra: {} });
  });
  it('leaves the input requirements and capability metadata unchanged', async () => {
    const input = structuredClone(requirements);
    const capability = structuredClone(supported);
    await new UptoStellarServer().enhancePaymentRequirements(input, capability, []);
    expect(input).toEqual(requirements);
    expect(capability).toEqual(supported);
  });
  it('returns unknown decimals for an unrecognized token', () => {
    const adapter = new UptoStellarServer();
    expect(adapter.getAssetDecimals(requirements.asset, requirements.network)).toBeUndefined();
  });
  it('rejects a contract as the Facilitator transaction-source address', async () => {
    await expect(
      new UptoStellarServer().enhancePaymentRequirements(
        requirements,
        {
          ...supported,
          extra: { ...supported.extra, facilitator: StrKey.encodeContract(Buffer.alloc(32, 6)) },
        },
        [],
      ),
    ).rejects.toThrow(/valid upto/);
  });
  it('accepts route metadata that matches the advertised terms', async () => {
    const input = { ...requirements, extra: { ...requirements.extra, ...supported.extra } };
    const result = await new UptoStellarServer().enhancePaymentRequirements(input, supported, []);
    expect(result.extra).toEqual(input.extra);
  });
  it.each([
    {
      field: 'Kernel address',
      extra: { settlementContract: StrKey.encodeContract(Buffer.alloc(32, 5)) },
    },
    {
      field: 'authorization address',
      extra: { facilitator: StrKey.encodeEd25519PublicKey(Buffer.alloc(32, 6)) },
    },
    { field: 'fee sponsorship', extra: { areFeesSponsored: false } },
  ])('rejects a conflicting route $field', async ({ extra }) => {
    await expect(
      new UptoStellarServer().enhancePaymentRequirements(
        { ...requirements, extra: { ...requirements.extra, ...extra } },
        supported,
        [],
      ),
    ).rejects.toThrow(/conflict/);
  });
  it('rejects missing advertised metadata', async () => {
    await expect(
      new UptoStellarServer().enhancePaymentRequirements(
        requirements,
        { ...supported, extra: undefined },
        [],
      ),
    ).rejects.toThrow(/valid upto/);
  });
});
