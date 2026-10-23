import { describe, expect, it } from 'vitest';
import { isContractAddress, isStellarAddress, supported } from './e2e-support.js';

describe('deployed /supported', () => {
  it('advertises exact and upto on testnet with sponsored fees', async () => {
    const { kinds, extensions } = await supported();

    expect(kinds.map((kind) => kind.scheme).sort()).toEqual(['exact', 'upto']);
    for (const kind of kinds) {
      expect(kind).toMatchObject({ x402Version: 2, network: 'stellar:testnet' });
    }
    expect(kinds.find((kind) => kind.scheme === 'exact')?.extra).toEqual({
      areFeesSponsored: true,
    });
    expect(extensions).toEqual([]);
  });

  it('names the upto settlement contract and authorization key', async () => {
    const upto = (await supported()).kinds.find((kind) => kind.scheme === 'upto');

    expect(upto?.extra?.areFeesSponsored).toBe(true);
    expect(isContractAddress(upto?.extra?.settlementContract)).toBe(true);
    expect(isStellarAddress(upto?.extra?.facilitator)).toBe(true);
  });

  it('lists only the upto authorization key as signer', async () => {
    const { kinds, signers } = await supported();
    const upto = kinds.find((kind) => kind.scheme === 'upto');

    expect(signers).toEqual({ 'stellar:*': [upto?.extra?.facilitator] });
  });
});
