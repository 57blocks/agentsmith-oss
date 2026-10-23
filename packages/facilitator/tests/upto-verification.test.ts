import { randomBytes } from 'node:crypto';
import { Keypair, StrKey, xdr } from '@stellar/stellar-sdk';
import type { PaymentPayload, PaymentRequirements } from '@x402/core/types';
import { createEd25519Signer } from '@x402/stellar';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SettlementContext,
  SettlementContexts,
} from '../src/modules/x402/services/channels/settlement-context.js';
import { UptoStellarScheme } from '../src/modules/x402/services/schemes/upto/upto-stellar.scheme.js';
import { fakeRpc, simulationFailure, simulationSuccess, type FakeRpc } from './fake-rpc.js';
import {
  asset,
  payTo,
  uptoAuthEntry,
  uptoPaymentXdr,
  type UptoPaymentOptions,
} from './settlement-fixtures.js';

const kernel = StrKey.encodeContract(randomBytes(32));
const authorization = Keypair.random();
const facilitator = authorization.publicKey();
const buyer = Keypair.random().publicKey();
const DEADLINE = 2_000;
/** Below the scheme's 60_000 default, so the ceiling tests fail if the option does not reach it. */
const MAX_FEE_STROOPS = 40_000;

/*
 * The stub reports ledger 1_990. With a 60 s timeout and upstream's 5 s ledger estimate, an
 * authorization may expire up to ledger 1_990 + 12 + 2 = 2_004.
 */
let rpc: FakeRpc;

beforeEach(() => {
  rpc = fakeRpc();
});

afterEach(() => {
  vi.restoreAllMocks();
});

function requirements(overrides: Partial<PaymentRequirements> = {}): PaymentRequirements {
  return {
    scheme: 'upto',
    network: 'stellar:testnet',
    asset,
    payTo,
    amount: '10000',
    maxTimeoutSeconds: 60,
    extra: { areFeesSponsored: true, settlementContract: kernel, facilitator },
    ...overrides,
  };
}

/** A Buyer's valid authorization for `requirements()`, changed by `options`. */
function transaction(options: UptoPaymentOptions = {}): string {
  return uptoPaymentXdr(kernel, facilitator, {
    source: facilitator,
    ...options,
    terms: { payer: buyer, ...options.terms },
  });
}

function payload(
  accepted: PaymentRequirements = requirements(),
  body: Record<string, unknown> = { transaction: transaction() },
): PaymentPayload {
  return { x402Version: 2, accepted, payload: body };
}

function uptoScheme(contexts = new SettlementContexts()): UptoStellarScheme {
  return new UptoStellarScheme(kernel, {
    rpcConfig: { url: 'http://127.0.0.1:1' },
    maxResourceFeeStroops: MAX_FEE_STROOPS,
    contexts,
    authorizationSigner: createEd25519Signer(authorization.secret()),
    feeBumpSigner: createEd25519Signer(Keypair.random().secret()),
  });
}

function verify(payment: PaymentPayload = payload(), terms: PaymentRequirements = requirements()) {
  return uptoScheme().verify(payment, terms);
}

const rejected = (invalidReason: string, payer?: string) => ({
  isValid: false,
  invalidReason,
  ...(payer ? { payer } : {}),
});

describe('upto verification of a valid authorization', () => {
  it('accepts it, names the Buyer as payer, and simulates the Buyer transaction once', async () => {
    const xdrText = transaction();

    expect(await verify(payload(requirements(), { transaction: xdrText }))).toEqual({
      isValid: true,
      payer: buyer,
    });
    expect(rpc.simulateTransaction).toHaveBeenCalledOnce();
    expect(rpc.simulateTransaction.mock.calls[0]![0].toXDR()).toBe(xdrText);
  });

  it('accepts a resource fee exactly at the resource ceiling', async () => {
    rpc.simulation = simulationSuccess(String(MAX_FEE_STROOPS));

    expect(await verify()).toEqual({ isValid: true, payer: buyer });
  });
});

describe('upto verification rejects request terms before reading the chain', () => {
  const otherAddress = Keypair.random().publicKey();
  const otherContract = StrKey.encodeContract(randomBytes(32));
  const cases: [string, () => [PaymentPayload, PaymentRequirements], string, string?][] = [
    [
      'an x402 v1 payload',
      () => [{ ...payload(), x402Version: 1 }, requirements()],
      'unsupported_scheme',
    ],
    [
      'an accepted scheme other than upto',
      () => [payload(requirements({ scheme: 'exact' })), requirements()],
      'unsupported_scheme',
    ],
    [
      'requirements whose payee differs from the accepted one',
      () => [payload(), requirements({ payTo: otherAddress })],
      'invalid_upto_stellar_payload_terms',
    ],
    [
      'a non-Stellar network',
      () => [payload(requirements({ network: 'eip155:1' })), requirements({ network: 'eip155:1' })],
      'invalid_upto_stellar_payload_terms',
    ],
    [
      'a zero accepted maximum',
      () => [payload(requirements({ amount: '0' })), requirements({ amount: '0' })],
      'invalid_upto_stellar_payload_amount',
    ],
    [
      'a fractional requested amount',
      () => [payload(), requirements({ amount: '1.5' })],
      'invalid_upto_stellar_payload_amount',
    ],
    [
      'a payload without a transaction',
      () => [payload(requirements(), {}), requirements()],
      'invalid_upto_stellar_payload_malformed',
    ],
    [
      'a transaction that is not a string',
      () => [payload(requirements(), { transaction: 42 }), requirements()],
      'invalid_upto_stellar_payload_malformed',
    ],
    [
      'a string that is not a transaction envelope',
      () => [payload(requirements(), { transaction: 'not-a-transaction' }), requirements()],
      'invalid_upto_stellar_payload_malformed',
    ],
    [
      'a Kernel call with ledger bounds, before checking the contract',
      () => [
        payload(requirements(), {
          transaction: uptoPaymentXdr(otherContract, facilitator, {
            source: facilitator,
            preconditions: { ledgerbounds: { minLedger: 0, maxLedger: 5_000 } },
          }),
        }),
        requirements(),
      ],
      'invalid_upto_stellar_payload_preconditions',
    ],
    [
      'a call to another contract',
      () => [
        payload(requirements(), {
          transaction: uptoPaymentXdr(otherContract, facilitator, { source: facilitator }),
        }),
        requirements(),
      ],
      'invalid_upto_stellar_payload_wrong_kernel',
    ],
    [
      'a call to another Kernel method',
      () => [
        payload(requirements(), { transaction: transaction({ method: 'transfer' }) }),
        requirements(),
      ],
      'invalid_upto_stellar_payload_wrong_kernel',
    ],
    [
      'a transaction sourced from an account other than the authorization key',
      () => [
        payload(requirements(), { transaction: transaction({ source: otherAddress }) }),
        requirements(),
      ],
      'invalid_upto_stellar_payload_unsafe_source',
    ],
    [
      'an operation sourced from another account',
      () => [
        payload(requirements(), { transaction: transaction({ operationSource: otherAddress }) }),
        requirements(),
      ],
      'invalid_upto_stellar_payload_unsafe_source',
    ],
    [
      'Kernel arguments that are not terms and an amount',
      () => [
        payload(requirements(), {
          transaction: transaction({ args: [xdr.ScVal.scvU32(1), xdr.ScVal.scvU32(1)] }),
        }),
        requirements(),
      ],
      'invalid_upto_stellar_payload_arguments',
    ],
    [
      'signed terms for another asset',
      () => [
        payload(requirements(), { transaction: transaction({ terms: { asset: otherContract } }) }),
        requirements(),
      ],
      'invalid_upto_stellar_payload_terms',
      buyer,
    ],
    [
      'signed terms for another payee',
      () => [
        payload(requirements(), { transaction: transaction({ terms: { payTo: otherAddress } }) }),
        requirements(),
      ],
      'invalid_upto_stellar_payload_terms',
      buyer,
    ],
    [
      'a signed maximum other than the accepted amount',
      () => [
        payload(requirements(), { transaction: transaction({ terms: { maxAmount: 9_999n } }) }),
        requirements(),
      ],
      'invalid_upto_stellar_payload_terms',
      buyer,
    ],
    [
      'signed terms naming another facilitator',
      () => [
        payload(requirements(), {
          transaction: transaction({ terms: { facilitator: otherAddress } }),
        }),
        requirements(),
      ],
      'invalid_upto_stellar_payload_terms',
      buyer,
    ],
    [
      'accepted terms naming another settlement contract',
      () => {
        const terms = requirements({
          extra: { areFeesSponsored: true, settlementContract: otherContract, facilitator },
        });
        return [payload(terms), terms];
      },
      'invalid_upto_stellar_payload_terms',
      buyer,
    ],
    [
      'accepted terms naming another facilitator',
      () => {
        const terms = requirements({
          extra: { areFeesSponsored: true, settlementContract: kernel, facilitator: otherAddress },
        });
        return [payload(terms), terms];
      },
      'invalid_upto_stellar_payload_terms',
      buyer,
    ],
    [
      'a requested amount below the maximum at verification',
      () => [payload(), requirements({ amount: '9999' })],
      'invalid_upto_stellar_payload_amount',
      buyer,
    ],
    [
      'a requested amount above the maximum',
      () => [payload(), requirements({ amount: '10001' })],
      'invalid_upto_stellar_payload_amount',
      buyer,
    ],
    [
      'a Kernel amount argument other than the signed maximum',
      () => [
        payload(requirements(), { transaction: transaction({ actual: 9_999n }) }),
        requirements(),
      ],
      'invalid_upto_stellar_payload_max_amount',
      buyer,
    ],
  ];

  it.each(cases)('%s', async (_, build, reason, payer) => {
    const [payment, terms] = build();

    expect(await verify(payment, terms)).toEqual(rejected(reason, payer));
    expect(rpc.getLatestLedger).not.toHaveBeenCalled();
    expect(rpc.simulateTransaction).not.toHaveBeenCalled();
  });
});

describe('upto settlement of an undecodable transaction', () => {
  it('rejects it as malformed without leasing a channel', async () => {
    const contexts = new SettlementContexts();
    const lookup = vi.spyOn(contexts, 'get');

    const result = await uptoScheme(contexts).settle(
      payload(requirements(), { transaction: 'not-a-transaction' }),
      requirements(),
    );

    expect(result).toEqual({
      success: false,
      network: 'stellar:testnet',
      transaction: '',
      errorReason: 'invalid_upto_stellar_payload_malformed',
    });
    expect(lookup).not.toHaveBeenCalled();
  });
});

describe('upto verification against the ledger window', () => {
  it.each([
    ['is not valid yet', { validAfterLedger: 1_995 }],
    ['has passed its deadline', { validAfterLedger: 0, deadlineLedger: 1_980 }],
  ])('rejects terms that %s, without simulating', async (_, terms) => {
    expect(await verify(payload(requirements(), { transaction: transaction({ terms }) }))).toEqual(
      rejected('invalid_upto_stellar_payload_expiration', buyer),
    );
    expect(rpc.simulateTransaction).not.toHaveBeenCalled();
  });
});

describe('upto verification at the edge of the timeout window', () => {
  // A 62 s timeout is 12.4 ledgers at 5 s, rounded up to 13: authorizations may expire up to
  // ledger 1_990 + 13 + 2 = 2_005.
  const terms = requirements({ maxTimeoutSeconds: 62 });
  const withDeadline = (deadlineLedger: number) =>
    payload(terms, { transaction: transaction({ terms: { deadlineLedger } }) });

  it('accepts a deadline at the last ledger the window allows', async () => {
    expect(await verify(withDeadline(2_005), terms)).toEqual({ isValid: true, payer: buyer });
  });

  it('rejects a deadline one ledger past the window, without simulating', async () => {
    expect(await verify(withDeadline(2_006), terms)).toEqual(
      rejected('invalid_upto_stellar_payload_expiration', buyer),
    );
    expect(rpc.simulateTransaction).not.toHaveBeenCalled();
  });
});

describe('upto verification of the simulation', () => {
  it('rejects a transaction whose simulation fails', async () => {
    rpc.simulation = simulationFailure();

    expect(await verify()).toEqual(
      rejected('invalid_upto_stellar_payload_simulation_failed', buyer),
    );
  });

  it('rejects a resource fee one stroop above the resource ceiling', async () => {
    rpc.simulation = simulationSuccess(String(MAX_FEE_STROOPS + 1));

    expect(await verify()).toEqual(
      rejected('invalid_upto_stellar_payload_fee_exceeds_maximum', buyer),
    );
  });

  it('reports an RPC failure as unexpected_verify_error, without its message', async () => {
    rpc.getLatestLedger.mockRejectedValueOnce(new Error('RPC https://secret.internal timed out'));

    expect(await verify()).toEqual({
      isValid: false,
      invalidReason: 'unexpected_verify_error',
      payer: buyer,
    });
  });
});

describe('upto verification of authorization entries', () => {
  const buyerEntry = (expirationLedger = DEADLINE) =>
    uptoAuthEntry(kernel, buyer, expirationLedger);
  const withAuth = (auth: xdr.SorobanAuthorizationEntry[]) =>
    payload(requirements(), { transaction: transaction({ auth }) });

  it('accepts an authorization by the facilitator key that expires by the deadline', async () => {
    const entries = [buyerEntry(), uptoAuthEntry(kernel, facilitator, DEADLINE)];

    expect(await verify(withAuth(entries))).toEqual({ isValid: true, payer: buyer });
  });

  it.each([
    [
      'an authorization by a third party',
      () => [buyerEntry(), uptoAuthEntry(kernel, Keypair.random().publicKey(), DEADLINE)],
    ],
    ['no Buyer authorization', () => []],
    ['two Buyer authorizations', () => [buyerEntry(), buyerEntry()]],
  ])('rejects %s', async (_, entries) => {
    expect(await verify(withAuth(entries()))).toEqual(
      rejected('invalid_upto_stellar_payload_auth', buyer),
    );
  });

  it('rejects a Buyer authorization that expired before the current ledger', async () => {
    expect(await verify(withAuth([buyerEntry(1_980)]))).toEqual(
      rejected('invalid_upto_stellar_payload_expired', buyer),
    );
  });

  it('rejects a Buyer authorization that does not expire at the deadline', async () => {
    expect(await verify(withAuth([buyerEntry(DEADLINE - 1)]))).toEqual(
      rejected('invalid_upto_stellar_payload_expiration', buyer),
    );
  });

  it('rejects a facilitator authorization that outlives the deadline', async () => {
    const entries = [buyerEntry(), uptoAuthEntry(kernel, facilitator, DEADLINE + 3)];

    expect(await verify(withAuth(entries))).toEqual(
      rejected('invalid_upto_stellar_payload_expiration', buyer),
    );
  });
});

describe('upto settlement checks the authorization again', () => {
  /** Thrown by the lease, so reaching it proves the settle-phase checks passed. */
  class Leased extends Error {}

  let acquire: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    acquire = vi.fn(async () => {
      throw new Leased();
    });
  });

  function settle(terms: PaymentRequirements) {
    const contexts = new SettlementContexts();
    const context = new SettlementContext({
      acquire,
    });
    return contexts.run(context, () => uptoScheme(contexts).settle(payload(), terms));
  }

  // Unlike verification, a settle-phase refusal does not name the Buyer as payer today.
  const refused = (errorReason: string) => ({
    success: false,
    network: 'stellar:testnet',
    transaction: '',
    errorReason,
    payer: undefined,
  });

  it.each([
    ['the signed maximum', '10000'],
    ['less than the signed maximum', '2500'],
  ])('leases a channel to charge %s', async (_, amount) => {
    await expect(settle(requirements({ amount }))).rejects.toBeInstanceOf(Leased);
    expect(acquire).toHaveBeenCalledOnce();
  });

  it('refuses a charge above the signed maximum before leasing', async () => {
    expect(await settle(requirements({ amount: '10001' }))).toEqual(
      refused('invalid_upto_stellar_payload_amount'),
    );
    expect(acquire).not.toHaveBeenCalled();
  });

  it('refuses an authorization that verified but has passed its deadline by settlement', async () => {
    expect(await verify()).toEqual({ isValid: true, payer: buyer });
    rpc.latestLedger = DEADLINE + 1;

    expect(await settle(requirements({ amount: '2500' }))).toEqual(
      refused('invalid_upto_stellar_payload_expiration'),
    );
    expect(acquire).not.toHaveBeenCalled();
  });

  it('simulates again at settlement and refuses a payment that no longer simulates', async () => {
    expect(await verify()).toEqual({ isValid: true, payer: buyer });
    rpc.simulation = simulationFailure();

    expect(await settle(requirements({ amount: '2500' }))).toEqual(
      refused('invalid_upto_stellar_payload_simulation_failed'),
    );
    expect(rpc.simulateTransaction).toHaveBeenCalledTimes(2);
    expect(acquire).not.toHaveBeenCalled();
  });
});
