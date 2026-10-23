import {
  Account,
  Address,
  nativeToScVal,
  xdr,
  BASE_FEE,
  Operation,
  StrKey,
  Transaction,
  TransactionBuilder,
  SorobanDataBuilder,
  scValToNative,
} from '@stellar/stellar-sdk';
import type { contract } from '@stellar/stellar-sdk';
import type * as StellarSdk from '@stellar/stellar-sdk';
import type * as Stellar from '@x402/stellar';
import type { ClientStellarSigner } from '@x402/stellar';
import { getNetworkPassphrase } from '@x402/stellar';
import type { PaymentRequirements } from '@x402/core/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UptoStellarClient } from '../../src/buyer.js';

const boundary = vi.hoisted(() => ({
  build: vi.fn(),
  getLatestLedger: vi.fn(),
  getEstimatedLedgerCloseTimeSeconds: vi.fn(),
  getRpcClient: vi.fn(),
  sendTransaction: vi.fn(),
}));
vi.mock('@stellar/stellar-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof StellarSdk>();
  return {
    ...actual,
    contract: { ...actual.contract, AssembledTransaction: { build: boundary.build } },
  };
});
vi.mock('@x402/stellar', async (importOriginal) => {
  const actual = await importOriginal<typeof Stellar>();
  return {
    ...actual,
    getRpcClient: boundary.getRpcClient,
    getEstimatedLedgerCloseTimeSeconds: boundary.getEstimatedLedgerCloseTimeSeconds,
  };
});

const payer = StrKey.encodeEd25519PublicKey(Buffer.alloc(32, 1));
const facilitator = StrKey.encodeEd25519PublicKey(Buffer.alloc(32, 2));
const asset = StrKey.encodeContract(Buffer.alloc(32, 3));
// The SDK-pinned Kernels; the client builds against these and refuses any other advertised value.
const kernel = 'CBB7WCIQOBOJ4G7JUPVOA3RI553HBSYQ3GLBJ25X7W7S7MRJIGVCXRE3';
const pubnetKernel = 'CCV4RALFBEE2QLKPK6H5ZX24CYMKIFN3723J5J4TMDEFWAFLELGYODNI';
const payTo = StrKey.encodeEd25519PublicKey(Buffer.alloc(32, 5));
const requirements: PaymentRequirements = {
  scheme: 'upto',
  network: 'stellar:testnet',
  asset,
  payTo,
  amount: '900719925474099312345',
  maxTimeoutSeconds: 60,
  extra: { settlementContract: kernel, facilitator, areFeesSponsored: true },
};

function signer(): ClientStellarSigner {
  return { address: payer, signAuthEntry: vi.fn(), signTransaction: vi.fn() };
}

function fixture(
  mutate: (entry: xdr.SorobanAuthorizationEntry) => void = () => {},
  kernelArg: string = kernel,
) {
  const identity = signer();
  const signAuthEntries = vi.fn().mockResolvedValue(undefined);
  const simulate = vi.fn().mockResolvedValue(undefined);
  const needsNonInvokerSigningBy = vi.fn().mockReturnValueOnce([payer]).mockReturnValue([]);
  boundary.build.mockImplementation(
    async (options: contract.AssembledTransactionOptions<xdr.ScVal>) => {
      const approval = invocation(asset, 'approve', [
        nativeToScVal(payer, { type: 'address' }),
        nativeToScVal(kernelArg, { type: 'address' }),
        nativeToScVal(requirements.amount, { type: 'i128' }),
        nativeToScVal(100 + Math.ceil(60 / (await boundary.getEstimatedLedgerCloseTimeSeconds())), {
          type: 'u32',
        }),
      ]);
      const entry = new xdr.SorobanAuthorizationEntry({
        credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
          new xdr.SorobanAddressCredentials({
            address: Address.fromString(payer).toScAddress(),
            nonce: xdr.Int64.fromString('1'),
            signatureExpirationLedger: 0,
            signature: xdr.ScVal.scvVoid(),
          }),
        ),
        rootInvocation: invocation(kernelArg, 'settle', [options.args![0]!], [approval]),
      });
      mutate(entry);
      const built = new TransactionBuilder(new Account(options.publicKey!, '1'), {
        fee: BASE_FEE,
        networkPassphrase: options.networkPassphrase,
      })
        .setTimeout(options.timeoutInSeconds ?? 60)
        .addOperation(
          Operation.invokeContractFunction({
            contract: options.contractId,
            function: options.method,
            args: options.args ?? [],
            auth: [entry],
          }),
        )
        .build();
      return {
        built,
        simulation: { transactionData: new SorobanDataBuilder().build() },
        signAuthEntries,
        simulate,
        needsNonInvokerSigningBy,
      };
    },
  );
  return { identity, signAuthEntries, simulate, needsNonInvokerSigningBy };
}

beforeEach(() => {
  vi.resetAllMocks();
  boundary.getLatestLedger.mockResolvedValue({ sequence: 100 });
  boundary.getEstimatedLedgerCloseTimeSeconds.mockResolvedValue(5);
  boundary.getRpcClient.mockReturnValue({
    getLatestLedger: boundary.getLatestLedger,
    sendTransaction: boundary.sendTransaction,
  });
});
afterEach(() => vi.restoreAllMocks());

describe('Kernel-backed Stellar upto Buyer', () => {
  it('builds the current Kernel ABI for any SEP-41 token and signs only Buyer authorization', async () => {
    const { identity, signAuthEntries, simulate } = fixture();
    const original = structuredClone(requirements);
    const payload = await new UptoStellarClient(identity, {
      url: 'https://rpc.example.com',
    }).createPaymentPayload(2, requirements);
    const options = boundary.build.mock.calls[0]![0];
    expect(options).toMatchObject({
      contractId: kernel,
      method: 'settle',
      publicKey: facilitator,
      rpcUrl: 'https://rpc.example.com',
      timeoutInSeconds: 60,
    });
    expect(boundary.getRpcClient).toHaveBeenCalledWith(requirements.network, {
      url: 'https://rpc.example.com',
    });
    expect(scValToNative(options.args[0])).toEqual({
      payer,
      asset,
      pay_to: payTo,
      facilitator,
      max_amount: BigInt(requirements.amount),
      valid_after_ledger: 100,
      deadline_ledger: 112,
    });
    expect(options.args[0].map().map((entry: xdr.ScMapEntry) => entry.key().switch().name)).toEqual(
      ['scvSymbol', 'scvSymbol', 'scvSymbol', 'scvSymbol', 'scvSymbol', 'scvSymbol', 'scvSymbol'],
    );
    expect(scValToNative(options.args[1])).toBe(BigInt(requirements.amount));
    expect(signAuthEntries).toHaveBeenCalledWith({
      address: payer,
      signAuthEntry: identity.signAuthEntry,
      expiration: 112,
    });
    expect(simulate).toHaveBeenCalledOnce();
    const transaction = new Transaction(
      String(payload.payload.transaction),
      getNetworkPassphrase(requirements.network),
    );
    expect(transaction.source).toBe(facilitator);
    expect(transaction.operations).toHaveLength(1);
    expect(requirements).toEqual(original);
    expect(identity.signTransaction).not.toHaveBeenCalled();
    expect(boundary.sendTransaction).not.toHaveBeenCalled();
  });

  it.each([
    ['stellar:testnet', kernel],
    ['stellar:pubnet', pubnetKernel],
  ] as const)(
    'uses the %s passphrase and its pinned Kernel, rounding expiration up',
    async (network, networkKernel) => {
      const { identity, signAuthEntries } = fixture(() => {}, networkKernel);
      boundary.getEstimatedLedgerCloseTimeSeconds.mockResolvedValue(7);
      await new UptoStellarClient(identity, {
        url: 'https://rpc.example.com',
      }).createPaymentPayload(2, {
        ...requirements,
        network,
        extra: { ...requirements.extra, settlementContract: networkKernel },
      });
      expect(boundary.build.mock.calls[0]![0].contractId).toBe(networkKernel);
      expect(boundary.build.mock.calls[0]![0].networkPassphrase).toBe(
        getNetworkPassphrase(network),
      );
      expect(signAuthEntries).toHaveBeenCalledWith({
        address: payer,
        signAuthEntry: identity.signAuthEntry,
        expiration: 109,
      });
    },
  );

  it.each([
    { name: 'missing Kernel', change: { extra: { facilitator, areFeesSponsored: true } } },
    {
      name: 'missing authorization address',
      change: { extra: { settlementContract: kernel, areFeesSponsored: true } },
    },
    {
      name: 'malformed Kernel',
      change: { extra: { ...requirements.extra, settlementContract: 'invalid' } },
    },
    {
      name: 'disabled sponsorship',
      change: { extra: { ...requirements.extra, areFeesSponsored: false } },
    },
    {
      name: 'contract Facilitator source',
      change: { extra: { ...requirements.extra, facilitator: asset } },
    },
    { name: 'wrong scheme', change: { scheme: 'exact' } },
    { name: 'wrong network', change: { network: 'eip155:1' as const } },
    { name: 'wrong token address', change: { asset: 'USDC' } },
    { name: 'zero maximum', change: { amount: '0' } },
    { name: 'fractional maximum', change: { amount: '1.1' } },
    { name: 'overflow maximum', change: { amount: (1n << 127n).toString() } },
    { name: 'invalid timeout', change: { maxTimeoutSeconds: 0 } },
  ])('rejects $name before RPC or signing', async ({ change }) => {
    const { identity, signAuthEntries } = fixture();
    await expect(
      new UptoStellarClient(identity, undefined).createPaymentPayload(2, {
        ...requirements,
        ...change,
      }),
    ).rejects.toThrow();
    expect(boundary.getLatestLedger).not.toHaveBeenCalled();
    expect(boundary.build).not.toHaveBeenCalled();
    expect(signAuthEntries).not.toHaveBeenCalled();
  });

  it('rejects v1 before RPC', async () => {
    const { identity } = fixture();
    await expect(
      new UptoStellarClient(identity, undefined).createPaymentPayload(1, requirements),
    ).rejects.toThrow();
    expect(boundary.getLatestLedger).not.toHaveBeenCalled();
  });

  it('rejects unrelated authorization requests before asking the Buyer to sign', async () => {
    const { identity, needsNonInvokerSigningBy, signAuthEntries } = fixture();
    needsNonInvokerSigningBy.mockReset().mockReturnValue([payer, payTo]);
    await expect(
      new UptoStellarClient(identity, undefined).createPaymentPayload(2, requirements),
    ).rejects.toThrow(/authorization/i);
    expect(signAuthEntries).not.toHaveBeenCalled();
  });

  it('does not ask for a signature when the simulation fails', async () => {
    const { identity, signAuthEntries } = fixture();
    boundary.build.mockResolvedValue({
      simulation: { error: 'token transfer rejected' },
      signAuthEntries,
    });
    await expect(
      new UptoStellarClient(identity, undefined).createPaymentPayload(2, requirements),
    ).rejects.toThrow(/simulation/i);
    expect(signAuthEntries).not.toHaveBeenCalled();
  });

  it('propagates wallet rejection without broadcasting', async () => {
    const { identity, signAuthEntries } = fixture();
    signAuthEntries.mockRejectedValue(new Error('Wallet declined'));
    await expect(
      new UptoStellarClient(identity, undefined).createPaymentPayload(2, requirements),
    ).rejects.toThrow('Wallet declined');
    expect(boundary.sendTransaction).not.toHaveBeenCalled();
  });

  it('does not return a payload with outstanding Buyer authorization', async () => {
    const { identity, needsNonInvokerSigningBy } = fixture();
    needsNonInvokerSigningBy.mockReset().mockReturnValue([payer]);
    await expect(
      new UptoStellarClient(identity, undefined).createPaymentPayload(2, requirements),
    ).rejects.toThrow(/authorization/i);
  });
});

function invocation(
  contractId: string,
  method: string,
  args: xdr.ScVal[],
  children: xdr.SorobanAuthorizedInvocation[] = [],
) {
  return new xdr.SorobanAuthorizedInvocation({
    function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
      new xdr.InvokeContractArgs({
        contractAddress: Address.fromString(contractId).toScAddress(),
        functionName: method,
        args,
      }),
    ),
    subInvocations: children,
  });
}

describe('Buyer authorization safety', () => {
  it.each([asset, pubnetKernel, StrKey.encodeContract(Buffer.alloc(32, 9))])(
    'rejects a Facilitator Kernel that is not the pinned one before RPC: %s',
    async (advertised) => {
      const { identity, signAuthEntries } = fixture();
      await expect(
        new UptoStellarClient(identity, undefined).createPaymentPayload(2, {
          ...requirements,
          extra: { ...requirements.extra, settlementContract: advertised },
        }),
      ).rejects.toThrow(/trusted.*Kernel/i);
      expect(boundary.build).not.toHaveBeenCalled();
      expect(signAuthEntries).not.toHaveBeenCalled();
      expect(identity.signAuthEntry).not.toHaveBeenCalled();
    },
  );

  it.each([
    'root contract',
    'root method',
    'terms',
    'token',
    'spender',
    'amount',
    'expiration',
    'extra call',
  ])('rejects altered %s with the correct Buyer before signing', async (change) => {
    const { identity, signAuthEntries } = fixture((entry) => {
      const root = entry.rootInvocation();
      const approval = root.subInvocations()[0]!;
      const call = approval.function().contractFn();
      if (change === 'root contract')
        root.function().contractFn().contractAddress(Address.fromString(asset).toScAddress());
      if (change === 'root method')
        root.function().contractFn().functionName('settle_with_approval');
      if (change === 'terms')
        root
          .function()
          .contractFn()
          .args([nativeToScVal('unrelated')]);
      if (change === 'token') call.contractAddress(Address.fromString(kernel).toScAddress());
      if (change === 'spender') call.args()[1] = nativeToScVal(payTo, { type: 'address' });
      if (change === 'amount') call.args()[2] = nativeToScVal('1', { type: 'i128' });
      if (change === 'expiration') call.args()[3] = nativeToScVal(999, { type: 'u32' });
      if (change === 'extra call') root.subInvocations([...root.subInvocations(), approval]);
    });
    await expect(
      new UptoStellarClient(identity, undefined).createPaymentPayload(2, requirements),
    ).rejects.toThrow(/authorization/i);
    expect(signAuthEntries).not.toHaveBeenCalled();
    expect(identity.signAuthEntry).not.toHaveBeenCalled();
  });
});
