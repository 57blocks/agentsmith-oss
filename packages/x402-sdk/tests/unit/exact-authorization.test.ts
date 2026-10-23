import {
  Address,
  StrKey,
  buildAuthorizationEntryPreimage,
  nativeToScVal,
  xdr,
} from '@stellar/stellar-sdk';
import type { ClientStellarSigner } from '@x402/stellar';
import { getNetworkPassphrase } from '@x402/stellar';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PaymentRequirements } from '@x402/core/types';
import { createPaymentClient } from '../../src/buyer/payment-client.js';

const boundary = vi.hoisted(() => ({ create: vi.fn() }));
// Exercise the real per-payment signer guard with exact signing as the framework boundary.
vi.mock('@x402/stellar/exact/client', () => ({
  ExactStellarScheme: class {
    readonly scheme = 'exact';
    constructor(private readonly signer: ClientStellarSigner) {}
    createPaymentPayload(version: number, requirement: PaymentRequirements) {
      return boundary.create(this.signer, version, requirement);
    }
  },
}));
const payer = StrKey.encodeEd25519PublicKey(Buffer.alloc(32, 1));
const recipient = StrKey.encodeEd25519PublicKey(Buffer.alloc(32, 2));
const token = StrKey.encodeContract(Buffer.alloc(32, 3));
const otherToken = StrKey.encodeContract(Buffer.alloc(32, 4));
const requirement: PaymentRequirements = {
  scheme: 'exact',
  network: 'stellar:testnet',
  asset: token,
  payTo: recipient,
  amount: '40000',
  maxTimeoutSeconds: 60,
  extra: { areFeesSponsored: true },
};
function call(
  target = token,
  method = 'transfer',
  args = [
    nativeToScVal(payer, { type: 'address' }),
    nativeToScVal(recipient, { type: 'address' }),
    nativeToScVal('40000', { type: 'i128' }),
  ],
) {
  return new xdr.SorobanAuthorizedInvocation({
    function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
      new xdr.InvokeContractArgs({
        contractAddress: Address.fromString(target).toScAddress(),
        functionName: method,
        args,
      }),
    ),
    subInvocations: [],
  });
}
function preimage(
  invocation: xdr.SorobanAuthorizedInvocation,
  version: 'legacy' | 'address',
  network = requirement.network,
  address = payer,
) {
  const credentials = new xdr.SorobanAddressCredentials({
    address: Address.fromString(address).toScAddress(),
    nonce: xdr.Int64.fromString('1'),
    signatureExpirationLedger: 112,
    signature: xdr.ScVal.scvVoid(),
  });
  const entry = new xdr.SorobanAuthorizationEntry({
    credentials:
      version === 'legacy'
        ? xdr.SorobanCredentials.sorobanCredentialsAddress(credentials)
        : xdr.SorobanCredentials.sorobanCredentialsAddressV2(credentials),
    rootInvocation: invocation,
  });
  return buildAuthorizationEntryPreimage(entry, 112, getNetworkPassphrase(network)).toXDR('base64');
}
function fixture(encoded: string) {
  const signAuthEntry = vi
    .fn<ClientStellarSigner['signAuthEntry']>()
    .mockResolvedValue({ signedAuthEntry: 'signature' });
  boundary.create.mockImplementation(async (signer: ClientStellarSigner) => {
    await signer.signAuthEntry(encoded, {
      networkPassphrase: getNetworkPassphrase(requirement.network),
      address: payer,
    });
    return { x402Version: 2, payload: { transaction: 'signed-payment' } };
  });
  const client = createPaymentClient({
    network: requirement.network,
    signer: { address: payer, signAuthEntry },
  });
  return {
    signAuthEntry,
    purchase: (quote = requirement) =>
      client.createPaymentPayload({
        x402Version: 2,
        resource: {
          url: 'https://seller.example/weather',
          description: '',
          mimeType: 'application/json',
        },
        accepts: [quote],
      }),
  };
}
beforeEach(() => vi.resetAllMocks());

describe('exact authorization at the real signer boundary', () => {
  it.each(['legacy', 'address'] as const)(
    'signs only the approved SEP-41 transfer with %s credentials',
    async (version) => {
      const encoded = preimage(call(), version);
      const { signAuthEntry, purchase } = fixture(encoded);
      expect((await purchase()).payload).toEqual({ transaction: 'signed-payment' });
      expect(signAuthEntry).toHaveBeenCalledExactlyOnceWith(encoded, {
        networkPassphrase: getNetworkPassphrase(requirement.network),
        address: payer,
      });
    },
  );
  it.each([
    'contract',
    'method',
    'payer',
    'recipient',
    'amount',
    'nested transfer',
    'network',
    'credential address',
    'malformed',
  ] as const)('rejects altered %s before the caller signer', async (change) => {
    const root = call();
    const fn = root.function().contractFn();
    if (change === 'contract') fn.contractAddress(Address.fromString(otherToken).toScAddress());
    if (change === 'method') fn.functionName('approve');
    if (change === 'payer') fn.args()[0] = nativeToScVal(recipient, { type: 'address' });
    if (change === 'recipient') fn.args()[1] = nativeToScVal(payer, { type: 'address' });
    if (change === 'amount') fn.args()[2] = nativeToScVal('80000', { type: 'i128' });
    if (change === 'nested transfer') root.subInvocations([call(otherToken)]);
    const encoded =
      change === 'malformed'
        ? 'invalid'
        : preimage(
            root,
            'address',
            change === 'network' ? 'stellar:pubnet' : requirement.network,
            change === 'credential address' ? recipient : payer,
          );
    const { signAuthEntry, purchase } = fixture(encoded);
    await expect(purchase()).rejects.toThrow(/authorization/i);
    expect(signAuthEntry).not.toHaveBeenCalled();
  });
});

describe('concurrent exact quote binding', () => {
  it('keeps each in-flight amount bound to its own signer guard', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { purchase, signAuthEntry } = fixture(preimage(call(), 'legacy'));
    const secondRoot = call();
    secondRoot.function().contractFn().args()[2] = nativeToScVal('80000', { type: 'i128' });
    const secondPreimage = preimage(secondRoot, 'legacy');
    boundary.create.mockImplementation(
      async (signer: ClientStellarSigner, version: number, quote: PaymentRequirements) => {
        if (quote.amount === '40000') await gate;
        await signer.signAuthEntry(
          quote.amount === '40000' ? preimage(call(), 'legacy') : secondPreimage,
        );
        return { x402Version: version, payload: { transaction: quote.amount } };
      },
    );
    const first = purchase();
    expect((await purchase({ ...requirement, amount: '80000' })).payload).toEqual({
      transaction: '80000',
    });
    release();
    expect((await first).payload).toEqual({ transaction: '40000' });
    expect(signAuthEntry.mock.calls.map(([encoded]) => encoded)).toEqual([
      secondPreimage,
      preimage(call(), 'legacy'),
    ]);
  });
});
