import { appendFileSync } from 'node:fs';
import {
  Asset,
  Keypair,
  Networks,
  StrKey,
  TransactionBuilder,
  contract,
  rpc,
  xdr,
  type FeeBumpTransaction,
  type Transaction,
} from '@stellar/stellar-sdk';
import type {
  Network,
  PaymentPayload,
  PaymentRequirements,
  SettleResponse,
} from '@x402/core/types';
import {
  createEd25519Signer,
  getEstimatedLedgerCloseTimeSeconds,
  getNetworkPassphrase,
  getRpcClient,
  getRpcUrl,
  type RpcConfig,
} from '@x402/stellar';
import { ExactStellarScheme } from '@x402/stellar/exact/client';

const NETWORK = 'stellar:testnet';
const HORIZON_URL = 'https://horizon-testnet.stellar.org';
const EXPLORER_URLS: Record<string, string> = {
  'stellar:testnet': 'https://stellar.expert/explorer/testnet/tx',
  'stellar:pubnet': 'https://stellar.expert/explorer/public/tx',
};
/** Native XLM through its Stellar Asset Contract: friendbot funds it, no trustline needed. */
export const XLM = Asset.native().contractId(Networks.TESTNET);

type Json = Record<string, unknown>;

export interface E2eEnv {
  facilitatorUrl: string;
  /** The deployment's channel count; the service does not expose its pool size. */
  channelCount: number;
  /** Sent as the Bearer credential; pubnet refuses payment routes without one. */
  apiKey?: string;
  /** Required on pubnet, which has no default RPC; testnet falls back to the public one. */
  rpcUrl?: string;
}

export function e2eEnv(): E2eEnv {
  const facilitatorUrl = process.env.E2E_FACILITATOR_URL?.trim().replace(/\/$/, '');
  if (!facilitatorUrl) throw new Error('E2E_FACILITATOR_URL is required');
  const channelCount = Number(process.env.E2E_CHANNEL_COUNT ?? 2);
  if (!Number.isSafeInteger(channelCount) || channelCount < 1) {
    throw new Error('E2E_CHANNEL_COUNT must be a positive integer');
  }
  const apiKey = process.env.E2E_API_KEY?.trim() || undefined;
  const rpcUrl = process.env.E2E_RPC_URL?.trim() || undefined;
  return { facilitatorUrl, channelCount, apiKey, rpcUrl };
}

function rpcConfig(): RpcConfig | undefined {
  const { rpcUrl } = e2eEnv();
  return rpcUrl ? { url: rpcUrl } : undefined;
}

export interface HttpResult {
  status: number;
  body: Json;
}

/**
 * Calls the facilitator with `apiKey` as the Bearer credential, `E2E_API_KEY` by default and none
 * for `null`. An answer that is not JSON, such as a load balancer's error page, throws.
 */
export async function call(
  path: string,
  body?: unknown,
  apiKey: string | null = e2eEnv().apiKey ?? null,
): Promise<HttpResult> {
  const url = `${e2eEnv().facilitatorUrl}${path}`;
  const response = await fetch(url, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      'content-type': 'application/json',
      ...(apiKey === null ? {} : { authorization: `Bearer ${apiKey}` }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  try {
    return { status: response.status, body: JSON.parse(text) as Json };
  } catch {
    throw new Error(`${url} answered ${response.status} with no JSON body: ${text.slice(0, 200)}`);
  }
}

export interface SupportedKind {
  x402Version: number;
  scheme: string;
  network: string;
  extra?: Json;
}

export interface Supported {
  kinds: SupportedKind[];
  extensions: string[];
  signers: Record<string, string[]>;
}

/** `/supported`, refusing any deployment that is not testnet-only: these tests spend real funds. */
export async function supported(): Promise<Supported> {
  const { status, body } = await call('/supported');
  if (status !== 200) throw new Error(`/supported answered ${status}: ${JSON.stringify(body)}`);
  const result = body as unknown as Supported;
  if (result.kinds.some((kind) => kind.network !== NETWORK)) {
    throw new Error(`refusing to pay: ${e2eEnv().facilitatorUrl} is not testnet-only`);
  }
  return result;
}

export async function kindOf(scheme: 'exact' | 'upto'): Promise<SupportedKind> {
  const kind = (await supported()).kinds.find((k) => k.scheme === scheme);
  if (!kind) throw new Error(`the facilitator does not advertise ${scheme}`);
  return kind;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A new testnet account funded by friendbot. */
export async function fundedAccount(): Promise<Keypair> {
  const keypair = Keypair.random();
  let lastError = '';
  for (let attempt = 0; attempt < 4; attempt += 1) {
    if (attempt > 0) await sleep(2_000 * attempt);
    try {
      const response = await fetch(`https://friendbot.stellar.org/?addr=${keypair.publicKey()}`);
      if (response.ok) return keypair;
      lastError = `${response.status} ${(await response.text()).slice(0, 200)}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }
  throw new Error(
    `friendbot could not fund a test account (not a facilitator fault): ${lastError}`,
  );
}

export function requirementsFor(
  kind: SupportedKind,
  terms: { payTo: string; amount: string; maxTimeoutSeconds?: number },
): PaymentRequirements {
  return {
    scheme: kind.scheme,
    network: NETWORK,
    asset: XLM,
    payTo: terms.payTo,
    amount: terms.amount,
    maxTimeoutSeconds: terms.maxTimeoutSeconds ?? 60,
    extra: kind.extra ?? {},
  };
}

function envelope(
  signed: Pick<PaymentPayload, 'x402Version' | 'payload'>,
  accepted: PaymentRequirements,
): PaymentPayload {
  return { ...signed, accepted, resource: { url: 'https://e2e.agentsmith.test/resource' } };
}

/** The Buyer side of `exact`, through the upstream client, on the requirements' network. */
export async function exactPayload(
  buyer: Keypair,
  requirements: PaymentRequirements,
): Promise<PaymentPayload> {
  const signer = createEd25519Signer(buyer.secret(), requirements.network);
  const client = new ExactStellarScheme(signer, rpcConfig());
  return envelope(await client.createPaymentPayload(2, requirements), requirements);
}

type KernelClient = {
  settle(args: {
    terms: {
      payer: string;
      asset: string;
      pay_to: string;
      facilitator: string;
      max_amount: string;
      valid_after_ledger: number;
      deadline_ledger: number;
    };
    actual_amount: string;
  }): Promise<{
    built: { toXDR(): string };
    needsNonInvokerSigningBy(options?: { includeAlreadySigned?: boolean }): string[];
    signAuthEntries(args: {
      address: string;
      signAuthEntry: ReturnType<typeof createEd25519Signer>['signAuthEntry'];
      expiration: number;
    }): Promise<void>;
  }>;
};

/** The Buyer side of the Kernel-backed `upto`: signs the Kernel call at its maximum. */
export async function uptoPayload(
  buyer: Keypair,
  requirements: PaymentRequirements,
): Promise<PaymentPayload> {
  const { settlementContract, facilitator } = requirements.extra;
  if (typeof settlementContract !== 'string' || typeof facilitator !== 'string') {
    throw new Error('upto requirements need settlementContract and facilitator in extra');
  }
  const { network } = requirements;
  const signer = createEd25519Signer(buyer.secret(), network);
  const ledger = await getRpcClient(network, rpcConfig()).getLatestLedger();
  const ledgerSeconds = await getEstimatedLedgerCloseTimeSeconds(network);
  const deadline = ledger.sequence + Math.ceil(requirements.maxTimeoutSeconds / ledgerSeconds);
  const client = await contract.Client.from<KernelClient>({
    contractId: settlementContract,
    rpcUrl: getRpcUrl(network, rpcConfig()),
    networkPassphrase: getNetworkPassphrase(network),
    // The facilitator's authorization key is the transaction source; the Buyer signs only its
    // authorization entry.
    publicKey: facilitator,
  });
  const tx = await client.settle({
    terms: {
      payer: signer.address,
      asset: requirements.asset,
      pay_to: requirements.payTo,
      facilitator,
      max_amount: requirements.amount,
      valid_after_ledger: ledger.sequence,
      deadline_ledger: deadline,
    },
    actual_amount: requirements.amount,
  });
  if (!tx.needsNonInvokerSigningBy({ includeAlreadySigned: true }).includes(signer.address)) {
    throw new Error('the Kernel call did not ask for the Buyer authorization');
  }
  await tx.signAuthEntries({
    address: signer.address,
    signAuthEntry: signer.signAuthEntry,
    expiration: deadline,
  });
  return envelope({ x402Version: 2, payload: { transaction: tx.built.toXDR() } }, requirements);
}

function transactionOf(payload: PaymentPayload): Transaction {
  const transactionXdr = (payload.payload as { transaction: string }).transaction;
  const passphrase = getNetworkPassphrase(payload.accepted.network);
  const parsed = TransactionBuilder.fromXDR(transactionXdr, passphrase) as
    Transaction | FeeBumpTransaction;
  if ('innerTransaction' in parsed) throw new Error('expected a Buyer transaction, not a fee-bump');
  return parsed;
}

function withEnvelope(
  payload: PaymentPayload,
  edit: (tx: xdr.Transaction) => void,
): PaymentPayload {
  const env = transactionOf(payload).toEnvelope();
  edit(env.v1().tx());
  return { ...payload, payload: { ...payload.payload, transaction: env.toXDR('base64') } };
}

/** Adds a `minSeqNum` precondition; the Buyer's auth entry does not cover the envelope. */
export function withMinSequence(payload: PaymentPayload, minSequence: string): PaymentPayload {
  return withEnvelope(payload, (tx) => {
    const cond = tx.cond();
    const timeBounds =
      cond.switch() === xdr.PreconditionType.precondTime() ? cond.timeBounds() : null;
    tx.cond(
      xdr.Preconditions.precondV2(
        new xdr.PreconditionsV2({
          timeBounds,
          ledgerBounds: null,
          minSeqNum: xdr.Int64.fromString(minSequence),
          minSeqAge: xdr.Uint64.fromString('0'),
          minSeqLedgerGap: 0,
          extraSigners: [],
        }),
      ),
    );
  });
}

/** Moves the Buyer's signed expiration by one ledger, which its signature no longer covers. */
export function withTamperedAuthorization(payload: PaymentPayload): PaymentPayload {
  return withEnvelope(payload, (tx) => {
    const op = tx.operations()[0];
    if (!op) throw new Error('the Buyer transaction has no operation');
    const entry = op.body().invokeHostFunctionOp().auth()[0];
    if (!entry) throw new Error('the Buyer transaction has no authorization entry');
    const credentials = entry.credentials().address();
    credentials.signatureExpirationLedger(credentials.signatureExpirationLedger() + 1);
  });
}

/** Native balance in stroops, from Horizon. */
export async function nativeBalance(address: string): Promise<bigint> {
  const response = await fetch(`${HORIZON_URL}/accounts/${address}`);
  if (!response.ok) throw new Error(`Horizon could not read ${address}: ${response.status}`);
  const account = (await response.json()) as {
    balances: { asset_type: string; balance: string }[];
  };
  const native = account.balances.find((b) => b.asset_type === 'native');
  if (!native) throw new Error(`${address} has no native balance`);
  const [whole = '0', fraction = ''] = native.balance.split('.');
  return BigInt(whole) * 10_000_000n + BigInt(fraction.padEnd(7, '0'));
}

/** Waits until Horizon has ingested the ledgers RPC already reported, then returns the balance. */
export async function settledBalance(address: string, expected: bigint): Promise<bigint> {
  let balance = await nativeBalance(address);
  for (let attempt = 0; balance !== expected && attempt < 10; attempt += 1) {
    await sleep(1_000);
    balance = await nativeBalance(address);
  }
  return balance;
}

/** The transaction's status on RPC, waiting while the node has not seen it yet. */
export async function transactionStatus(
  hash: string,
  network: Network = NETWORK,
): Promise<rpc.Api.GetTransactionStatus> {
  const server = getRpcClient(network, rpcConfig());
  for (let attempt = 0; attempt < 15; attempt += 1) {
    const result = await server.getTransaction(hash);
    if (result.status !== rpc.Api.GetTransactionStatus.NOT_FOUND) return result.status;
    await sleep(1_000);
  }
  return rpc.Api.GetTransactionStatus.NOT_FOUND;
}

export function isTransactionHash(value: unknown): boolean {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

/** Prints a settled hash with its explorer link and adds it to the GitHub step summary. */
export function recordSettlement(label: string, response: Json): void {
  const { transaction: hash, network = NETWORK } = response as Partial<SettleResponse>;
  if (!hash) return;
  const link = `${EXPLORER_URLS[network] ?? EXPLORER_URLS[NETWORK]}/${hash}`;
  process.stdout.write(`${label}: ${hash} ${link}\n`);
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (summary) appendFileSync(summary, `- ${label}: [\`${hash}\`](${link})\n`);
}

export function isStellarAddress(value: unknown): boolean {
  return typeof value === 'string' && StrKey.isValidEd25519PublicKey(value);
}

export function isContractAddress(value: unknown): boolean {
  return typeof value === 'string' && StrKey.isValidContract(value);
}

export function x402Body(paymentPayload: unknown, paymentRequirements: unknown): Json {
  return { x402Version: 2, paymentPayload, paymentRequirements };
}

export { sleep };
