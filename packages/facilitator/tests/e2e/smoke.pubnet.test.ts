import { rpc } from '@stellar/stellar-sdk';
import type { PaymentPayload, PaymentRequirements } from '@x402/core/types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import packageJson from '../../package.json' with { type: 'json' };
import {
  call,
  exactPayload,
  isContractAddress,
  isStellarAddress,
  isTransactionHash,
  recordSettlement,
  transactionStatus,
  uptoPayload,
  x402Body,
  type HttpResult,
} from './e2e-support.js';
import {
  PUBNET,
  SMOKE_ASSETS,
  balanceOf,
  formatUnits,
  pubnetEnv,
  pubnetKind,
  pubnetRequirements,
  pubnetSupported,
  readinessProblems,
  settledBalanceOf,
  waitForLedgers,
  type SmokeAsset,
} from './pubnet-support.js';

const { buyer, payTo, allowSpend } = pubnetEnv();
const payer = buyer.publicKey();
const XLM = SMOKE_ASSETS[0]!;
const USDC = SMOKE_ASSETS[1]!;

const verify = (payload: PaymentPayload, terms: PaymentRequirements) =>
  call('/verify', x402Body(payload, terms));
const settle = (payload: PaymentPayload, terms: PaymentRequirements) =>
  call('/settle', x402Body(payload, terms));

async function terms(scheme: 'exact' | 'upto', asset: SmokeAsset, amount: bigint) {
  return pubnetRequirements(await pubnetKind(scheme), { asset, payTo, amount });
}

interface Balances {
  payer: bigint;
  payTo: bigint;
}

async function balancesOf(asset: SmokeAsset): Promise<Balances> {
  const [ofPayer, ofPayTo] = await Promise.all([
    balanceOf(payer, asset.asset),
    balanceOf(payTo, asset.asset),
  ]);
  return { payer: ofPayer, payTo: ofPayTo };
}

interface Settlement {
  label: string;
  asset: SmokeAsset;
  before: Balances;
  amount: bigint;
}

/**
 * Checks the settlement landed and moved exactly `amount`: the payer loses no more than that,
 * since the facilitator sponsors the fee.
 */
async function expectSettled(result: HttpResult, { label, asset, before, amount }: Settlement) {
  expect(result.status).toBe(200);
  expect(result.body).toMatchObject({ success: true, network: PUBNET, payer });
  expect(isTransactionHash(result.body.transaction)).toBe(true);
  recordSettlement(label, result.body);
  expect(await transactionStatus(result.body.transaction as string, PUBNET)).toBe(
    rpc.Api.GetTransactionStatus.SUCCESS,
  );
  expect(await settledBalanceOf(payTo, asset.asset, before.payTo + amount)).toBe(
    before.payTo + amount,
  );
  expect(await settledBalanceOf(payer, asset.asset, before.payer - amount)).toBe(
    before.payer - amount,
  );
}

/** Fails the suite's hook, so none of its settles is sent, when the run cannot complete. */
async function refuseUnlessReady() {
  const problems = await readinessProblems(payer, payTo);
  if (problems.length > 0) throw new Error(`refusing to pay: ${problems.join('; ')}`);
}

const startBalances = new Map<string, Balances>();

beforeAll(async () => {
  for (const asset of SMOKE_ASSETS) startBalances.set(asset.code, await balancesOf(asset));
});

afterAll(async () => {
  const lines = [`payer ${payer} -> payTo ${payTo}`];
  for (const asset of SMOKE_ASSETS) {
    const start = startBalances.get(asset.code);
    if (!start) continue;
    const end = await balancesOf(asset);
    for (const role of ['payer', 'payTo'] as const) {
      const change = formatUnits(end[role] - start[role]);
      lines.push(
        `${asset.code} ${role}: ${formatUnits(start[role])} -> ${formatUnits(end[role])} (${change})`,
      );
    }
  }
  process.stdout.write(`${lines.join('\n')}\n`);
});

describe('pubnet preflight, before any payment', () => {
  it("reports a healthy pubnet service running this checkout's version", async () => {
    const result = await call('/health');

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ ok: true, network: PUBNET, version: packageJson.version });
  });

  // Guards run before body validation, so an empty body proves the key alone was refused.
  it.each([
    ['/verify', 'without an API key', null],
    ['/verify', 'with an unknown API key', 'not-a-registered-key'],
    ['/settle', 'without an API key', null],
    ['/settle', 'with an unknown API key', 'not-a-registered-key'],
  ])('refuses %s %s', async (path, _, apiKey) => {
    const result = await call(path, {}, apiKey);

    expect(result.status).toBe(401);
    expect(result.body).toEqual({
      error: { code: 'UNAUTHORIZED', message: 'Bearer token required' },
    });
  });

  it('refuses /supported without an API key', async () => {
    const result = await call('/supported', undefined, null);

    expect(result.status).toBe(401);
    expect(result.body).toEqual({
      error: { code: 'UNAUTHORIZED', message: 'Bearer token required' },
    });
  });

  it('refuses /supported with an unknown API key', async () => {
    const result = await call('/supported', undefined, 'not-a-registered-key');

    expect(result.status).toBe(401);
    expect(result.body).toMatchObject({ error: { code: 'UNAUTHORIZED' } });
  });

  it('advertises exact and upto on pubnet only, with sponsored fees', async () => {
    const { kinds, signers } = await pubnetSupported();
    const upto = kinds.find((kind) => kind.scheme === 'upto');

    expect(kinds.map((kind) => kind.scheme).sort()).toEqual(['exact', 'upto']);
    expect(kinds.find((kind) => kind.scheme === 'exact')?.extra).toEqual({
      areFeesSponsored: true,
    });
    expect(upto?.extra?.areFeesSponsored).toBe(true);
    expect(isContractAddress(upto?.extra?.settlementContract)).toBe(true);
    expect(isStellarAddress(upto?.extra?.facilitator)).toBe(true);
    expect(signers).toEqual({ 'stellar:*': [upto?.extra?.facilitator] });
  });

  it('finds enough XLM and USDC on the payer, and a USDC trustline on payTo', async () => {
    expect(await readinessProblems(payer, payTo)).toEqual([]);
  });
});

describe.runIf(allowSpend).each(SMOKE_ASSETS)('pubnet payments in $code', (asset) => {
  let exactSettled: { payload: PaymentPayload; terms: PaymentRequirements; hash: string };
  let uptoSettled: { payload: PaymentPayload; terms: PaymentRequirements; hash: string };

  beforeAll(refuseUnlessReady);

  it('verifies and settles an exact payment', async () => {
    const exact = await terms('exact', asset, asset.exact);
    const payload = await exactPayload(buyer, exact);
    const before = await balancesOf(asset);

    const verified = await verify(payload, exact);
    expect(verified.status).toBe(200);
    expect(verified.body).toMatchObject({ isValid: true, payer });

    const settled = await settle(payload, exact);
    await expectSettled(settled, {
      label: `${asset.code} exact`,
      asset,
      before,
      amount: asset.exact,
    });
    exactSettled = { payload, terms: exact, hash: settled.body.transaction as string };
  });

  it('answers a resent exact settle with the same transaction, charging once', async () => {
    const before = await balancesOf(asset);

    const again = await settle(exactSettled.payload, exactSettled.terms);

    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ success: true, transaction: exactSettled.hash });
    // A second transfer would land within a ledger or two of the answer; give it time to show.
    await waitForLedgers(2);
    expect(await balancesOf(asset)).toEqual(before);
  });

  it('settles part of an upto maximum', async () => {
    const upto = await terms('upto', asset, asset.uptoMax);
    const payload = await uptoPayload(buyer, upto);
    const before = await balancesOf(asset);

    const verified = await verify(payload, upto);
    expect(verified.body).toMatchObject({ isValid: true, payer });

    const partial = { ...upto, amount: asset.uptoPartial.toString() };
    const settled = await settle(payload, partial);
    expect(settled.body.amount).toBe(asset.uptoPartial.toString());
    await expectSettled(settled, {
      label: `${asset.code} upto partial`,
      asset,
      before,
      amount: asset.uptoPartial,
    });
    uptoSettled = { payload, terms: partial, hash: settled.body.transaction as string };
  });

  it('answers a resent upto settle with the same transaction, charging once', async () => {
    const before = await balancesOf(asset);

    const again = await settle(uptoSettled.payload, uptoSettled.terms);

    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({
      success: true,
      transaction: uptoSettled.hash,
      amount: asset.uptoPartial.toString(),
      payer,
    });
    await waitForLedgers(2);
    expect(await balancesOf(asset)).toEqual(before);
  });

  it('settles an upto maximum in full', async () => {
    const upto = await terms('upto', asset, asset.uptoMax);
    const payload = await uptoPayload(buyer, upto);
    const before = await balancesOf(asset);

    const settled = await settle(payload, upto);
    expect(settled.body.amount).toBe(asset.uptoMax.toString());
    await expectSettled(settled, {
      label: `${asset.code} upto full`,
      asset,
      before,
      amount: asset.uptoMax,
    });
  });
});

describe.runIf(allowSpend)('pubnet settles of one authorization sent at once', () => {
  beforeAll(refuseUnlessReady);

  it('broadcasts one transaction and charges once', async () => {
    const exact = await terms('exact', XLM, XLM.exact);
    const payload = await exactPayload(buyer, exact);
    const before = await balancesOf(XLM);

    const answers = await Promise.all([settle(payload, exact), settle(payload, exact)]);

    // Whichever arrives second may be answered while the first's transaction is still in flight.
    const hash = answers[0]!.body.transaction;
    expect(isTransactionHash(hash)).toBe(true);
    for (const answer of answers) {
      expect(answer.status).toBe(200);
      expect(answer.body.transaction).toBe(hash);
      expect(['settled', 'settlement_pending']).toContain(
        answer.body.success === true ? 'settled' : answer.body.errorReason,
      );
    }
    await expectSettled(await settle(payload, exact), {
      label: 'XLM exact sent at once',
      asset: XLM,
      before,
      amount: XLM.exact,
    });
    // A second transfer would land within a ledger or two; give it time to show.
    await waitForLedgers(2);
    expect(await balancesOf(XLM)).toEqual({
      payer: before.payer - XLM.exact,
      payTo: before.payTo + XLM.exact,
    });
  });
});

describe.runIf(allowSpend)('pubnet rejections, before any broadcast', () => {
  let exact: PaymentRequirements;
  let exactSigned: PaymentPayload;
  let upto: PaymentRequirements;
  let uptoSigned: PaymentPayload;
  let before: Balances;

  beforeAll(async () => {
    await refuseUnlessReady();
    exact = await terms('exact', XLM, XLM.exact);
    upto = await terms('upto', XLM, XLM.uptoMax);
    [exactSigned, uptoSigned] = await Promise.all([
      exactPayload(buyer, exact),
      uptoPayload(buyer, upto),
    ]);
    before = await balancesOf(XLM);
  });

  const exactChanges: [string, (base: PaymentRequirements) => PaymentRequirements, string][] = [
    ['amount', (base) => ({ ...base, amount: (XLM.exact * 2n).toString() }), 'wrong_amount'],
    ['recipient', (base) => ({ ...base, payTo: payer }), 'wrong_recipient'],
    ['asset', (base) => ({ ...base, asset: USDC.contract }), 'wrong_asset'],
  ];

  it.each(exactChanges)('rejects exact terms with a different %s', async (_, change, reason) => {
    const result = await verify(exactSigned, change(exact));

    expect(result.body).toMatchObject({
      isValid: false,
      invalidReason: `invalid_exact_stellar_payload_${reason}`,
    });
  });

  it('rejects requirements for testnet', async () => {
    const testnet = { ...exact, network: 'stellar:testnet' as const };

    const result = await verify({ ...exactSigned, accepted: testnet }, testnet);

    expect(result.body).toMatchObject({ isValid: false, invalidReason: 'invalid_network' });
  });

  it('rejects an upto settle above the signed maximum', async () => {
    const result = await settle(uptoSigned, { ...upto, amount: (XLM.uptoMax + 1n).toString() });

    expect(result.body).toMatchObject({
      success: false,
      errorReason: 'invalid_upto_stellar_payload_amount',
    });
  });

  it('settles zero upto usage without sending, then refuses that authorization at its maximum', async () => {
    // Its own authorization: a zero settlement closes it for every later settle.
    const payload = await uptoPayload(buyer, upto);

    const zero = await settle(payload, { ...upto, amount: '0' });
    expect(zero.body).toEqual({
      success: true,
      network: 'stellar:pubnet',
      transaction: '',
      amount: '0',
      payer,
    });

    const charge = await settle(payload, upto);
    expect(charge.body).toEqual({
      success: false,
      errorReason: 'settlement_amount_conflict',
      transaction: '',
      network: 'stellar:pubnet',
    });
  });

  it('charged nothing for any rejected payment', async () => {
    expect(await balancesOf(XLM)).toEqual(before);
  });
});
