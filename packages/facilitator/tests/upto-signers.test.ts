import { randomBytes } from 'node:crypto';
import {
  Account,
  Address,
  BASE_FEE,
  Keypair,
  Networks,
  Operation,
  StrKey,
  TransactionBuilder,
  authorizeEntry,
  xdr,
} from '@stellar/stellar-sdk';
import { createEd25519Signer } from '@x402/stellar';
import type { PaymentPayload, PaymentRequirements } from '@x402/core/types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  SigningError,
  buildSettlementTransaction,
  signFacilitatorAuthEntry,
} from '../src/modules/x402/services/schemes/upto/upto-settlement.js';
import { checkUptoPayment } from '../src/modules/x402/services/schemes/upto/upto-verification.js';
import { UptoStellarScheme } from '../src/modules/x402/services/schemes/upto/upto-stellar.scheme.js';
import {
  SettlementContext,
  SettlementContexts,
} from '../src/modules/x402/services/channels/settlement-context.js';

vi.mock(
  import('../src/modules/x402/services/schemes/upto/upto-verification.js'),
  async (importOriginal) => {
    const actual = await importOriginal();
    return { ...actual, checkUptoPayment: vi.fn(actual.checkUptoPayment) };
  },
);
vi.mock(
  import('../src/modules/x402/services/schemes/upto/upto-settlement.js'),
  async (importOriginal) => {
    const actual = await importOriginal();
    return { ...actual, buildSettlementTransaction: vi.fn(actual.buildSettlementTransaction) };
  },
);

describe('upto signer roles', () => {
  it('advertises only the authorization key, also published in extra', () => {
    const randomKeypair = () => Keypair.fromRawEd25519Seed(randomBytes(32));
    const authorization = randomKeypair();
    const feePayer = createEd25519Signer(randomKeypair().secret());
    const scheme = new UptoStellarScheme(randomKeypair().publicKey(), {
      maxResourceFeeStroops: 60_000,
      authorizationSigner: createEd25519Signer(authorization.secret()),
      contexts: new SettlementContexts(),
      feeBumpSigner: feePayer,
    });

    expect(scheme.getExtra('stellar:testnet').facilitator).toBe(authorization.publicKey());
    expect(scheme.getSigners('stellar:testnet')).toEqual([authorization.publicKey()]);
  });

  it('signs the facilitator auth entry through the configured signer', async () => {
    const authorization = Keypair.fromRawEd25519Seed(randomBytes(32));
    const contract = Address.contract(randomBytes(32));
    const invocation = new xdr.SorobanAuthorizedInvocation({
      function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
        new xdr.InvokeContractArgs({
          contractAddress: contract.toScAddress(),
          functionName: 'settle',
          args: [],
        }),
      ),
      subInvocations: [],
    });
    const entry = new xdr.SorobanAuthorizationEntry({
      rootInvocation: invocation,
      credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
        new xdr.SorobanAddressCredentials({
          address: Address.fromString(authorization.publicKey()).toScAddress(),
          nonce: new xdr.Int64(123),
          signatureExpirationLedger: 0,
          signature: xdr.ScVal.scvVec([]),
        }),
      ),
    });
    const localSigner = createEd25519Signer(authorization.secret());
    const signAuthEntry = vi.fn(localSigner.signAuthEntry);

    const signed = await signFacilitatorAuthEntry(
      entry,
      { ...localSigner, signAuthEntry },
      150,
      Networks.TESTNET,
    );

    expect(signAuthEntry).toHaveBeenCalledOnce();
    expect(signAuthEntry.mock.calls[0]?.[1]).toEqual({
      networkPassphrase: Networks.TESTNET,
      address: authorization.publicKey(),
    });
    expect(signed.credentials().address().signatureExpirationLedger()).toBe(150);
    expect(signed.credentials().address().signature().vec()?.length).toBe(1);
  });
});

function authEntryFor(address: string): xdr.SorobanAuthorizationEntry {
  return new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
      new xdr.SorobanAddressCredentials({
        address: new Address(address).toScAddress(),
        nonce: new xdr.Int64(7),
        signatureExpirationLedger: 0,
        signature: xdr.ScVal.scvVoid(),
      }),
    ),
    rootInvocation: new xdr.SorobanAuthorizedInvocation({
      function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
        new xdr.InvokeContractArgs({
          contractAddress: new Address(StrKey.encodeContract(Buffer.alloc(32, 7))).toScAddress(),
          functionName: 'settle',
          args: [],
        }),
      ),
      subInvocations: [],
    }),
  });
}

describe('upto authorization signing', () => {
  it('signs an authorization entry through the signer exactly as a local keypair would', async () => {
    const key = Keypair.fromRawEd25519Seed(randomBytes(32));
    const viaSigner = await signFacilitatorAuthEntry(
      authEntryFor(key.publicKey()),
      createEd25519Signer(key.secret()),
      1000,
      Networks.TESTNET,
    );
    const viaKeypair = await authorizeEntry(
      authEntryFor(key.publicKey()),
      key,
      1000,
      Networks.TESTNET,
    );
    expect(viaSigner.toXDR('base64')).toBe(viaKeypair.toXDR('base64'));
  });

  it('turns a signer error into a SigningError', async () => {
    const key = Keypair.fromRawEd25519Seed(randomBytes(32));
    const failing = {
      ...createEd25519Signer(key.secret()),
      signAuthEntry: async () => ({
        signedAuthEntry: '',
        error: { message: 'kms throttled', code: -1 },
      }),
    };
    const attempt = signFacilitatorAuthEntry(
      authEntryFor(key.publicKey()),
      failing,
      1000,
      Networks.TESTNET,
    );
    await expect(attempt).rejects.toThrow(/kms throttled/);
    await expect(attempt).rejects.toBeInstanceOf(SigningError);
  });
});

describe('upto settle signing failures', () => {
  const contract = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM';
  const refusal = { signedTxXdr: '', error: { message: 'kms throttled', code: -1 } };

  // Vitest 3 mockReset restores the real implementation and drops unused once-mocks.
  afterEach(() => {
    vi.mocked(checkUptoPayment).mockReset();
    vi.mocked(buildSettlementTransaction).mockReset();
  });

  // Everything before signing is stubbed: a signer that returns { error } must surface as
  // settle_upto_signing_failed, which the engine relies on to release the channel.
  async function settleWith(overrides: {
    channel?: Partial<ReturnType<typeof createEd25519Signer>>;
    authorization?: Partial<ReturnType<typeof createEd25519Signer>>;
    feeBump?: Partial<ReturnType<typeof createEd25519Signer>>;
  }) {
    const secret = () => Keypair.fromRawEd25519Seed(randomBytes(32)).secret();
    const channel = { ...createEd25519Signer(secret()), ...overrides.channel };
    const authorization = { ...createEd25519Signer(secret()), ...overrides.authorization };
    const feeBump = { ...createEd25519Signer(secret()), ...overrides.feeBump };
    const unsigned = new TransactionBuilder(new Account(channel.address, '1'), {
      fee: BASE_FEE,
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(Operation.bumpSequence({ bumpTo: '2' }))
      .setTimeout(60)
      .build();
    vi.mocked(checkUptoPayment).mockResolvedValueOnce({
      response: { isValid: true },
      transaction: unsigned,
      simulation: {} as never,
      payer: Keypair.random().publicKey(),
    });
    vi.mocked(buildSettlementTransaction).mockImplementationOnce(async (context) => {
      await signFacilitatorAuthEntry(
        authEntryFor(authorization.address),
        context.authorizationSigner,
        1000,
        Networks.TESTNET,
      );
      return unsigned;
    });
    const contexts = new SettlementContexts();
    const scheme = new UptoStellarScheme(contract, {
      maxResourceFeeStroops: 60_000,
      authorizationSigner: authorization,
      contexts,
      feeBumpSigner: feeBump,
    });
    const context = new SettlementContext({
      acquire: async () => ({ address: channel.address, signer: channel, finish: async () => {} }),
    });
    const requirements = {
      scheme: 'upto',
      network: 'stellar:testnet',
      amount: '10000',
      asset: contract,
      payTo: channel.address,
      maxTimeoutSeconds: 60,
      extra: { settlementContract: contract, facilitator: authorization.address },
    } as PaymentRequirements;
    return contexts.run(context, () =>
      scheme.settle(
        { x402Version: 2, accepted: requirements, payload: {} } as PaymentPayload,
        requirements,
      ),
    );
  }

  it.each([
    ['the channel signTransaction', { channel: { signTransaction: async () => refusal } }],
    ['the fee payer signTransaction', { feeBump: { signTransaction: async () => refusal } }],
    // Covers the SigningError-to-reason mapping via the real authorizationCallback, not the real
    // assembly path.
    [
      'the authorization signAuthEntry',
      {
        authorization: {
          signAuthEntry: async () => ({ signedAuthEntry: '', error: refusal.error }),
        },
      },
    ],
  ])('reports settle_upto_signing_failed when %s returns an error', async (_, overrides) => {
    const result = await settleWith(overrides);

    expect(result.success).toBe(false);
    expect(result.errorReason).toBe('settle_upto_signing_failed');
    expect(result.transaction).toBe('');
  });
});
