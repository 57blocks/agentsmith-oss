import type { Keypair } from '@stellar/stellar-sdk';
import { rpc } from '@stellar/stellar-sdk';
import type { PaymentPayload, PaymentRequirements } from '@x402/core/types';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  call,
  exactPayload,
  fundedAccount,
  isTransactionHash,
  kindOf,
  nativeBalance,
  recordSettlement,
  requirementsFor,
  settledBalance,
  transactionStatus,
  uptoPayload,
  withMinSequence,
  withTamperedAuthorization,
  x402Body,
  type HttpResult,
} from './e2e-support.js';

/** A token contract the payments are not in. */
const OTHER_ASSET = 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA';
// Stroops of native XLM.
const AMOUNT = 1_000_000n;
const PARTIAL = 400_000n;

let buyer: Keypair;
let payTo: string;

const verify = (payload: PaymentPayload, terms: PaymentRequirements) =>
  call('/verify', x402Body(payload, terms));
const settle = (payload: PaymentPayload, terms: PaymentRequirements) =>
  call('/settle', x402Body(payload, terms));

async function terms(scheme: 'exact' | 'upto', amount = AMOUNT): Promise<PaymentRequirements> {
  return requirementsFor(await kindOf(scheme), { payTo, amount: amount.toString() });
}

/** Settles, checks the transaction landed, and that `payTo` received exactly `received`. */
async function expectSettled(result: HttpResult, label: string, before: bigint, received: bigint) {
  expect(result.status).toBe(200);
  expect(result.body).toMatchObject({ success: true, network: 'stellar:testnet' });
  expect(isTransactionHash(result.body.transaction)).toBe(true);
  recordSettlement(label, result.body);
  expect(await transactionStatus(result.body.transaction as string)).toBe(
    rpc.Api.GetTransactionStatus.SUCCESS,
  );
  expect(await settledBalance(payTo, before + received)).toBe(before + received);
}

beforeAll(async () => {
  [buyer, payTo] = await Promise.all([fundedAccount(), fundedAccount().then((k) => k.publicKey())]);
});

describe('deployed payments', () => {
  let exactSettled: { payload: PaymentPayload; terms: PaymentRequirements; hash: string };

  it('verifies and settles an exact payment in XLM', async () => {
    const exact = await terms('exact');
    const payload = await exactPayload(buyer, exact);
    const before = await nativeBalance(payTo);

    const verified = await verify(payload, exact);
    expect(verified.status).toBe(200);
    expect(verified.body).toMatchObject({ isValid: true, payer: buyer.publicKey() });

    const settled = await settle(payload, exact);
    await expectSettled(settled, 'exact', before, AMOUNT);
    exactSettled = { payload, terms: exact, hash: settled.body.transaction as string };
  });

  it('answers a resent exact settle with the same transaction, charging once', async () => {
    const before = await nativeBalance(payTo);

    const again = await settle(exactSettled.payload, exactSettled.terms);

    expect(again.body).toMatchObject({ success: true, transaction: exactSettled.hash });
    expect(await nativeBalance(payTo)).toBe(before);
  });

  it('settles part of an upto maximum', async () => {
    const upto = await terms('upto');
    const payload = await uptoPayload(buyer, upto);
    const before = await nativeBalance(payTo);

    const verified = await verify(payload, upto);
    expect(verified.body).toMatchObject({ isValid: true, payer: buyer.publicKey() });

    const settled = await settle(payload, { ...upto, amount: PARTIAL.toString() });
    expect(settled.body.amount).toBe(PARTIAL.toString());
    await expectSettled(settled, 'upto partial', before, PARTIAL);
  });

  it('settles an upto maximum in full', async () => {
    const upto = await terms('upto');
    const payload = await uptoPayload(buyer, upto);
    const before = await nativeBalance(payTo);

    const settled = await settle(payload, upto);
    expect(settled.body.amount).toBe(AMOUNT.toString());
    await expectSettled(settled, 'upto full', before, AMOUNT);
  });
});

describe('deployed rejections, before any broadcast', () => {
  let exact: PaymentRequirements;
  let exactSigned: PaymentPayload;
  let upto: PaymentRequirements;
  let uptoSigned: PaymentPayload;
  let balanceBefore: bigint;

  beforeAll(async () => {
    exact = await terms('exact');
    upto = await terms('upto');
    [exactSigned, uptoSigned] = await Promise.all([
      exactPayload(buyer, exact),
      uptoPayload(buyer, upto),
    ]);
    balanceBefore = await nativeBalance(payTo);
  });

  it('rejects a settle body without a payment payload as malformed', async () => {
    const result = await call('/settle', { x402Version: 2, paymentRequirements: exact });

    expect(result.status).toBe(400);
    expect(result.body).toMatchObject({ success: false, errorReason: 'invalid_payload' });
  });

  it('rejects an unsupported x402 version', async () => {
    const result = await call('/verify', { ...x402Body(exactSigned, exact), x402Version: 1 });

    expect(result.body).toMatchObject({ isValid: false, invalidReason: 'invalid_x402_version' });
  });

  const exactChanges: [string, (base: PaymentRequirements) => PaymentRequirements, string][] = [
    ['amount', (base) => ({ ...base, amount: (AMOUNT * 2n).toString() }), 'wrong_amount'],
    ['recipient', (base) => ({ ...base, payTo: buyer.publicKey() }), 'wrong_recipient'],
    ['asset', (base) => ({ ...base, asset: OTHER_ASSET }), 'wrong_asset'],
  ];

  it.each(exactChanges)('rejects exact terms with a different %s', async (_, change, reason) => {
    const changed = change(exact);
    const invalidReason = `invalid_exact_stellar_payload_${reason}`;

    expect((await verify(exactSigned, changed)).body).toMatchObject({
      isValid: false,
      invalidReason,
    });
    expect((await settle(exactSigned, changed)).body).toMatchObject({
      success: false,
      errorReason: invalidReason,
    });
  });

  it('rejects an exact payment presented as upto', async () => {
    const result = await verify(exactSigned, { ...exact, scheme: 'upto', extra: upto.extra });

    expect(result.body).toMatchObject({ isValid: false, invalidReason: 'unsupported_scheme' });
  });

  it('rejects requirements for a network the deployment does not serve', async () => {
    const pubnet = { ...exact, network: 'stellar:pubnet' as const };

    const result = await verify({ ...exactSigned, accepted: pubnet }, pubnet);

    expect(result.body).toMatchObject({ isValid: false, invalidReason: 'invalid_network' });
  });

  it('rejects an exact authorization whose signed fields were changed', async () => {
    const result = await verify(withTamperedAuthorization(exactSigned), exact);

    // The signature no longer verifies, so the Buyer's transfer fails in simulation.
    expect(result.body).toMatchObject({
      isValid: false,
      invalidReason: 'invalid_exact_stellar_payload_simulation_failed',
    });
  });

  it('rejects an upto settle above the signed maximum', async () => {
    const result = await settle(uptoSigned, { ...upto, amount: (AMOUNT + 1n).toString() });

    expect(result.body).toMatchObject({
      success: false,
      errorReason: 'invalid_upto_stellar_payload_amount',
    });
  });

  it('rejects an upto settle to a different recipient', async () => {
    const result = await settle(uptoSigned, { ...upto, payTo: buyer.publicKey() });

    expect(result.body).toMatchObject({
      success: false,
      errorReason: 'invalid_upto_stellar_payload_terms',
    });
  });

  it('settles zero upto usage without sending, then refuses that authorization at its maximum', async () => {
    // Its own authorization: a zero settlement closes it for every later settle.
    const payload = await uptoPayload(buyer, upto);

    const zero = await settle(payload, { ...upto, amount: '0' });
    expect(zero.body).toEqual({
      success: true,
      network: 'stellar:testnet',
      transaction: '',
      amount: '0',
      payer: buyer.publicKey(),
    });

    const charge = await settle(payload, upto);
    expect(charge.body).toEqual({
      success: false,
      errorReason: 'settlement_amount_conflict',
      transaction: '',
      network: 'stellar:testnet',
    });
  });

  it.each([
    ['exact', 'invalid_exact_stellar_payload_preconditions'],
    ['upto', 'invalid_upto_stellar_payload_preconditions'],
  ] as const)('rejects an %s transaction carrying preconditions', async (scheme, reason) => {
    const [signed, accepted] = scheme === 'exact' ? [exactSigned, exact] : [uptoSigned, upto];
    const withPrecondition = withMinSequence(signed, '1');

    expect((await verify(withPrecondition, accepted)).body).toMatchObject({
      isValid: false,
      invalidReason: reason,
    });
    expect((await settle(withPrecondition, accepted)).body).toMatchObject({
      success: false,
      errorReason: reason,
    });
  });

  it('charged nothing for any rejected payment', async () => {
    expect(await nativeBalance(payTo)).toBe(balanceBefore);
  });
});
