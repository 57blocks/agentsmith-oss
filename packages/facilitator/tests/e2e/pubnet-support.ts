import { Asset, Keypair, Networks, StrKey } from '@stellar/stellar-sdk';
import type { PaymentRequirements } from '@x402/core/types';
import { call, sleep, type Supported, type SupportedKind } from './e2e-support.js';

export const PUBNET = 'stellar:pubnet';
const HORIZON_URL = 'https://horizon.stellar.org';
/** Circle's USDC on pubnet. */
const USDC_ISSUER = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';
/** Lumens kept per ledger entry the account owns, in stroops. */
const BASE_RESERVE = 5_000_000n;

/** An asset paid through its Stellar Asset Contract, with the amounts one run spends from it. */
export interface SmokeAsset {
  code: 'XLM' | 'USDC';
  asset: Asset;
  contract: string;
  /** Base units, 7 decimals for both. */
  exact: bigint;
  /** Exact payments a run settles: one alone, plus one sent twice at once for XLM. */
  exactPayments: bigint;
  uptoMax: bigint;
  uptoPartial: bigint;
}

export const SMOKE_ASSETS: readonly SmokeAsset[] = [
  {
    code: 'XLM',
    asset: Asset.native(),
    contract: Asset.native().contractId(Networks.PUBLIC),
    exact: 100_000n,
    exactPayments: 2n,
    uptoMax: 100_000n,
    uptoPartial: 40_000n,
  },
  {
    code: 'USDC',
    asset: new Asset('USDC', USDC_ISSUER),
    contract: new Asset('USDC', USDC_ISSUER).contractId(Networks.PUBLIC),
    exact: 10_000n,
    exactPayments: 1n,
    uptoMax: 50_000n,
    uptoPartial: 20_000n,
  },
];

/** What one run moves out of the payer: its exact payments, then upto partly and in full. */
export function spendOf(asset: SmokeAsset): bigint {
  return asset.exact * asset.exactPayments + asset.uptoPartial + asset.uptoMax;
}

export interface PubnetEnv {
  buyer: Keypair;
  payTo: string;
  /** Only `E2E_ALLOW_PUBNET_SPEND=true` lets the suite send a settle. */
  allowSpend: boolean;
}

/** The paying and receiving accounts; swap them between runs to move the funds back. */
export function pubnetEnv(): PubnetEnv {
  const secret = process.env.E2E_BUYER_SECRET?.trim();
  if (!secret || !StrKey.isValidEd25519SecretSeed(secret)) {
    throw new Error('E2E_BUYER_SECRET must be the paying account secret seed');
  }
  const payTo = process.env.E2E_PAY_TO?.trim() ?? '';
  if (!StrKey.isValidEd25519PublicKey(payTo)) {
    throw new Error('E2E_PAY_TO must be the receiving G-account');
  }
  const buyer = Keypair.fromSecret(secret);
  if (buyer.publicKey() === payTo) throw new Error('E2E_PAY_TO must differ from the buyer');
  return { buyer, payTo, allowSpend: process.env.E2E_ALLOW_PUBNET_SPEND === 'true' };
}

/** `/supported`, refusing any deployment that is not pubnet-only: a typo must not hit testnet. */
export async function pubnetSupported(): Promise<Supported> {
  const { status, body } = await call('/supported');
  if (status !== 200) throw new Error(`/supported answered ${status}: ${JSON.stringify(body)}`);
  const result = body as unknown as Supported;
  if (
    !Array.isArray(result.kinds) ||
    result.kinds.length === 0 ||
    result.kinds.some((kind) => kind.network !== PUBNET)
  ) {
    throw new Error('refusing to run: the target is not a pubnet-only facilitator');
  }
  return result;
}

export async function pubnetKind(scheme: 'exact' | 'upto'): Promise<SupportedKind> {
  const kind = (await pubnetSupported()).kinds.find((k) => k.scheme === scheme);
  if (!kind) throw new Error(`the facilitator does not advertise ${scheme}`);
  return kind;
}

export function pubnetRequirements(
  kind: SupportedKind,
  terms: { asset: SmokeAsset; payTo: string; amount: bigint },
): PaymentRequirements {
  return {
    scheme: kind.scheme,
    network: PUBNET,
    asset: terms.asset.contract,
    payTo: terms.payTo,
    amount: terms.amount.toString(),
    maxTimeoutSeconds: 60,
    extra: kind.extra ?? {},
  };
}

interface HorizonAccount {
  subentry_count: number;
  num_sponsoring?: number;
  num_sponsored?: number;
  balances: {
    asset_type: string;
    asset_code?: string;
    asset_issuer?: string;
    balance: string;
    selling_liabilities: string;
  }[];
}

async function horizonAccount(address: string): Promise<HorizonAccount> {
  const response = await fetch(`${HORIZON_URL}/accounts/${address}`);
  if (!response.ok) throw new Error(`Horizon could not read ${address}: ${response.status}`);
  return (await response.json()) as HorizonAccount;
}

function toUnits(amount: string): bigint {
  const [whole = '0', fraction = ''] = amount.split('.');
  return BigInt(whole) * 10_000_000n + BigInt(fraction.padEnd(7, '0'));
}

function balanceLine(account: HorizonAccount, asset: Asset) {
  return account.balances.find((b) =>
    asset.isNative()
      ? b.asset_type === 'native'
      : b.asset_code === asset.getCode() && b.asset_issuer === asset.getIssuer(),
  );
}

/** Balance in base units; an account without the trustline throws. */
export async function balanceOf(address: string, asset: Asset): Promise<bigint> {
  const line = balanceLine(await horizonAccount(address), asset);
  if (!line) throw new Error(`${address} holds no ${asset.getCode()} trustline`);
  return toUnits(line.balance);
}

/**
 * Waits up to 30 s for Horizon to reach `expected`, then returns the balance. Pubnet Horizon can
 * trail RPC by several ledgers, and a timeout here reports a payment that did land as missing.
 */
export async function settledBalanceOf(
  address: string,
  asset: Asset,
  expected: bigint,
): Promise<bigint> {
  let balance = await balanceOf(address, asset);
  for (let attempt = 0; balance !== expected && attempt < 30; attempt += 1) {
    await sleep(1_000);
    balance = await balanceOf(address, asset);
  }
  return balance;
}

/** Lumens the account can send without dropping below its reserve, in stroops. */
export async function spendableLumens(address: string): Promise<bigint> {
  const account = await horizonAccount(address);
  const entries =
    2 + account.subentry_count + (account.num_sponsoring ?? 0) - (account.num_sponsored ?? 0);
  const native = balanceLine(account, Asset.native());
  if (!native) throw new Error(`${address} has no native balance`);
  return (
    toUnits(native.balance) - BigInt(entries) * BASE_RESERVE - toUnits(native.selling_liabilities)
  );
}

export function formatUnits(units: bigint): string {
  const sign = units < 0n ? '-' : '';
  const abs = units < 0n ? -units : units;
  return `${sign}${abs / 10_000_000n}.${(abs % 10_000_000n).toString().padStart(7, '0')}`;
}

async function horizonLedger(): Promise<number> {
  const response = await fetch(`${HORIZON_URL}/ledgers?order=desc&limit=1`);
  if (!response.ok) throw new Error(`Horizon could not read its latest ledger: ${response.status}`);
  const page = (await response.json()) as { _embedded: { records: { sequence: number }[] } };
  const latest = page._embedded.records[0];
  if (!latest) throw new Error('Horizon returned no ledger');
  return latest.sequence;
}

/**
 * Waits until Horizon has ingested `count` more ledgers. A transaction sent before the call has then
 * landed in Horizon, so an unchanged balance afterwards means it was not charged.
 */
export async function waitForLedgers(count: number): Promise<void> {
  const target = (await horizonLedger()) + count;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if ((await horizonLedger()) >= target) return;
    await sleep(1_000);
  }
  throw new Error(`Horizon did not reach ledger ${target} within 60 s`);
}

/**
 * What stops a paying run before its first settle: an unhealthy or non-pubnet target, a missing
 * scheme, a payer short of one run's spend, or a payTo without the USDC trustline. Empty when ready.
 */
export async function readinessProblems(payer: string, payTo: string): Promise<string[]> {
  const problems: string[] = [];
  const health = await call('/health');
  if (health.status !== 200 || health.body.ok !== true || health.body.network !== PUBNET) {
    problems.push(`/health answered ${health.status}: ${JSON.stringify(health.body)}`);
  }
  const schemes = (await pubnetSupported()).kinds.map((kind) => kind.scheme);
  for (const scheme of ['exact', 'upto']) {
    if (!schemes.includes(scheme)) problems.push(`the facilitator does not advertise ${scheme}`);
  }
  for (const asset of SMOKE_ASSETS) {
    const available = asset.asset.isNative()
      ? await spendableLumens(payer)
      : await balanceOf(payer, asset.asset);
    if (available < spendOf(asset)) {
      problems.push(
        `payer can spend ${formatUnits(available)} ${asset.code}, a run needs ${formatUnits(spendOf(asset))}`,
      );
    }
  }
  const payToAccount = await horizonAccount(payTo);
  for (const { asset, code } of SMOKE_ASSETS) {
    if (!balanceLine(payToAccount, asset)) problems.push(`${payTo} holds no ${code} trustline`);
  }
  return problems;
}
