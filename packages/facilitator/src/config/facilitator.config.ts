import { StrKey } from '@stellar/stellar-sdk';

const TESTNET_RPC_URL = 'https://soroban-testnet.stellar.org';

export type StellarNetwork = 'stellar:testnet' | 'stellar:pubnet';

export type SigningMode = 'env' | 'kms';

export interface KmsSigningConfig {
  region: string;
  feePayerAddress: string;
  channelAddresses: string[];
  authorizationAddress?: string;
}

export interface ChannelPoolConfig {
  /** Carries the store password; never logged. */
  storeUrl: string;
  storeCommandTimeoutMs: number;
  /** How long a settlement waits for a free channel before failing as pool-full. */
  acquireWaitMs: number;
  cooldownMs: number;
  unknownMarginMs: number;
  leaseVerifyBudgetMs: number;
  leasePollOverheadPct: number;
  leaseMarginMs: number;
}

export interface FacilitatorConfig {
  port: number;
  host: string;
  nodeEnv: string;
  network: StellarNetwork;
  rpcUrl: string;
  signingMode: SigningMode;
  kms?: KmsSigningConfig;
  privateKey?: string;
  feeBumpSecret?: string;
  channelSecrets: string[];
  /** Refuses a payment whose simulated resource fee exceeds it; the fee-bump bid is not counted. */
  maxResourceFeeStroops: number;
  feeBumpBid: FeeBumpBidConfig;
  maxBodySize: string;
  rateLimitWindowMs: number;
  rateLimitMax: number;
  /** Registrations allowed per IP in each window; registration needs no key. */
  registerRateLimitWindowMs: number;
  registerRateLimitMax: number;
  /**
   * HMAC key for registration source IPs, from `REGISTRATION_IP_HASH_KEY`. Unset means the
   * registration limit is not enforced while the channel store is unreachable. Never logged.
   */
  registrationIpHashKey?: string;
  settlementCacheTtlMs: number;
  settlementCacheMaxEntries: number;
  uptoKernelContract?: string;
  bazaarSettlementUrl?: string;
  bazaarSettlementApiKey?: string;
  trustProxy: string[];
  corsOrigins: '*' | string[];
  shutdownTimeoutMs: number;
  databaseUrl: string;
  /** Admin name → admin API key, from `ADMIN_API_KEYS`; empty means no one can use admin routes. */
  adminApiKeys: Record<string, string>;
  channelPool: ChannelPoolConfig;
}

/** How the fee payer bids for inclusion: the recent median Soroban inclusion fee × `multiplier`. */
export interface FeeBumpBidConfig {
  multiplier: number;
  /** Per operation; at least the network minimum of 100. */
  maxBidStroops: number;
}

/** The network minimum inclusion fee per operation; a lower bid cap could never be met. */
const MIN_BID_STROOPS = 100;

function list(value: string | undefined): string[] {
  return (value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function positiveInteger(name: string, raw: string | undefined, fallback: number): number {
  const value = Number(raw ?? fallback);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function positiveNumber(name: string, raw: string | undefined, fallback: number): number {
  const value = Number(raw?.trim() || fallback);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number`);
  return value;
}

function parseFeeBumpBid(env: NodeJS.ProcessEnv): FeeBumpBidConfig {
  const maxBidStroops = positiveInteger(
    'MAX_FEE_BUMP_BID_STROOPS',
    env.MAX_FEE_BUMP_BID_STROOPS,
    2_000,
  );
  if (maxBidStroops < MIN_BID_STROOPS) {
    throw new Error(`MAX_FEE_BUMP_BID_STROOPS must be at least ${MIN_BID_STROOPS}`);
  }
  return {
    multiplier: positiveNumber('FEE_BUMP_BID_MULTIPLIER', env.FEE_BUMP_BID_MULTIPLIER, 1.5),
    maxBidStroops,
  };
}

function url(name: string, raw: string, allowDevelopmentHttp = false): string {
  const parsed = new URL(raw);
  if (
    parsed.protocol !== 'https:' &&
    parsed.hostname !== 'localhost' &&
    parsed.hostname !== '127.0.0.1' &&
    !allowDevelopmentHttp
  ) {
    throw new Error(`${name} must use HTTPS unless it points to localhost`);
  }
  return parsed.toString().replace(/\/$/, '');
}

function parseNetwork(env: NodeJS.ProcessEnv): StellarNetwork {
  const network = env.STELLAR_NETWORK || 'stellar:testnet';
  if (network !== 'stellar:testnet' && network !== 'stellar:pubnet') {
    throw new Error('STELLAR_NETWORK must be stellar:testnet or stellar:pubnet');
  }
  return network;
}

function parsePort(env: NodeJS.ProcessEnv): number {
  const port = positiveInteger('PORT', env.PORT, 8407);
  if (port > 65535) throw new Error('PORT must be at most 65535');
  return port;
}

type SignerKeys = Pick<FacilitatorConfig, 'privateKey' | 'feeBumpSecret' | 'channelSecrets'>;

function parseSignerKeys(env: NodeJS.ProcessEnv): SignerKeys {
  const privateKey = env.FACILITATOR_STELLAR_PRIVATE_KEY?.trim() || undefined;
  const feeBumpSecret = env.FACILITATOR_STELLAR_FEE_BUMP_SECRET?.trim() || undefined;
  const channelSecrets = list(env.FACILITATOR_STELLAR_CHANNEL_SECRETS);
  if (!feeBumpSecret || channelSecrets.length === 0) {
    throw new Error(
      'FACILITATOR_STELLAR_FEE_BUMP_SECRET and FACILITATOR_STELLAR_CHANNEL_SECRETS are required; ' +
        'single-signer mode (FACILITATOR_STELLAR_PRIVATE_KEY alone) was removed',
    );
  }
  if (env.X402_UPTO_KERNEL_CONTRACT?.trim() && !privateKey) {
    throw new Error('FACILITATOR_STELLAR_PRIVATE_KEY is required for upto authorization');
  }
  return { privateKey, feeBumpSecret, channelSecrets };
}

const SEED_VARIABLES = [
  'FACILITATOR_STELLAR_PRIVATE_KEY',
  'FACILITATOR_STELLAR_FEE_BUMP_SECRET',
  'FACILITATOR_STELLAR_CHANNEL_SECRETS',
] as const;

function parseSigningMode(env: NodeJS.ProcessEnv): SigningMode {
  const mode = env.FACILITATOR_SIGNING_MODE?.trim() || 'env';
  if (mode !== 'env' && mode !== 'kms') {
    throw new Error('FACILITATOR_SIGNING_MODE must be env or kms');
  }
  return mode;
}

function stellarAddress(name: string, raw: string, plural = false): string {
  if (!StrKey.isValidEd25519PublicKey(raw)) {
    throw new Error(
      plural ? `${name} must contain Stellar G addresses` : `${name} must be a Stellar G address`,
    );
  }
  return raw;
}

function requiredAddress(env: NodeJS.ProcessEnv, name: string): string {
  const raw = env[name]?.trim();
  if (!raw) throw new Error(`${name} is required when FACILITATOR_SIGNING_MODE=kms`);
  return stellarAddress(name, raw);
}

function parseKmsSigning(env: NodeJS.ProcessEnv): KmsSigningConfig {
  const seeds = SEED_VARIABLES.filter((name) => env[name]?.trim());
  if (seeds.length > 0) {
    throw new Error(`${seeds.join(', ')} must not be set when FACILITATOR_SIGNING_MODE=kms`);
  }
  const region = env.FACILITATOR_KMS_REGION?.trim() || env.AWS_REGION?.trim();
  if (!region) {
    throw new Error(
      'FACILITATOR_KMS_REGION or AWS_REGION is required when FACILITATOR_SIGNING_MODE=kms',
    );
  }
  const channels = list(env.FACILITATOR_KMS_CHANNEL_ADDRESSES);
  if (channels.length === 0) {
    throw new Error(
      'FACILITATOR_KMS_CHANNEL_ADDRESSES is required when FACILITATOR_SIGNING_MODE=kms',
    );
  }
  const authorization = env.FACILITATOR_KMS_AUTHORIZATION_ADDRESS?.trim();
  if (env.X402_UPTO_KERNEL_CONTRACT?.trim() && !authorization) {
    throw new Error('FACILITATOR_KMS_AUTHORIZATION_ADDRESS is required for upto in kms mode');
  }
  if (authorization && !env.X402_UPTO_KERNEL_CONTRACT?.trim()) {
    throw new Error(
      'FACILITATOR_KMS_AUTHORIZATION_ADDRESS is only used with X402_UPTO_KERNEL_CONTRACT',
    );
  }
  return {
    region,
    feePayerAddress: requiredAddress(env, 'FACILITATOR_KMS_FEE_PAYER_ADDRESS'),
    channelAddresses: channels.map((raw) =>
      stellarAddress('FACILITATOR_KMS_CHANNEL_ADDRESSES', raw, true),
    ),
    ...(authorization
      ? {
          authorizationAddress: stellarAddress(
            'FACILITATOR_KMS_AUTHORIZATION_ADDRESS',
            authorization,
          ),
        }
      : {}),
  };
}

type Signing = Pick<
  FacilitatorConfig,
  'signingMode' | 'kms' | 'privateKey' | 'feeBumpSecret' | 'channelSecrets'
>;

function parseSigning(env: NodeJS.ProcessEnv): Signing {
  const signingMode = parseSigningMode(env);
  if (signingMode === 'kms') {
    return { signingMode, kms: parseKmsSigning(env), channelSecrets: [] };
  }
  // Deployed networks sign with KMS; environment keys are for local development only.
  if ((env.NODE_ENV || 'development') === 'production') {
    throw new Error(
      'FACILITATOR_SIGNING_MODE=env is not allowed when NODE_ENV=production; use kms',
    );
  }
  return { signingMode, ...parseSignerKeys(env) };
}

type BazaarSettings = Pick<FacilitatorConfig, 'bazaarSettlementUrl' | 'bazaarSettlementApiKey'>;

function parseBazaar(env: NodeJS.ProcessEnv): BazaarSettings {
  const bazaarSettlementUrl = env.BAZAAR_SETTLEMENT_URL?.trim()
    ? url(
        'BAZAAR_SETTLEMENT_URL',
        env.BAZAAR_SETTLEMENT_URL.trim(),
        (env.NODE_ENV || 'development') !== 'production',
      )
    : undefined;
  const bazaarSettlementApiKey = env.BAZAAR_SETTLEMENT_API_KEY?.trim() || undefined;
  if (bazaarSettlementUrl && !bazaarSettlementApiKey) {
    throw new Error(
      'BAZAAR_SETTLEMENT_API_KEY is required when BAZAAR_SETTLEMENT_URL is configured',
    );
  }
  return { bazaarSettlementUrl, bazaarSettlementApiKey };
}

type Limits = Pick<
  FacilitatorConfig,
  | 'maxResourceFeeStroops'
  | 'maxBodySize'
  | 'rateLimitWindowMs'
  | 'rateLimitMax'
  | 'registerRateLimitWindowMs'
  | 'registerRateLimitMax'
  | 'settlementCacheTtlMs'
  | 'settlementCacheMaxEntries'
  | 'shutdownTimeoutMs'
>;

function parseLimits(env: NodeJS.ProcessEnv): Limits {
  return {
    maxResourceFeeStroops: positiveInteger(
      'MAX_RESOURCE_FEE_STROOPS',
      env.MAX_RESOURCE_FEE_STROOPS,
      // The highest resource fee measured on pubnet, an upto settlement, was 59,380 stroops.
      60_000,
    ),
    maxBodySize: env.MAX_BODY_SIZE?.trim() || '256kb',
    rateLimitWindowMs: positiveInteger('RATE_LIMIT_WINDOW_MS', env.RATE_LIMIT_WINDOW_MS, 60_000),
    rateLimitMax: positiveInteger('RATE_LIMIT_MAX', env.RATE_LIMIT_MAX, 120),
    registerRateLimitWindowMs: positiveInteger(
      'REGISTER_RATE_LIMIT_WINDOW_MS',
      env.REGISTER_RATE_LIMIT_WINDOW_MS,
      3_600_000,
    ),
    registerRateLimitMax: positiveInteger(
      'REGISTER_RATE_LIMIT_MAX',
      env.REGISTER_RATE_LIMIT_MAX,
      5,
    ),
    settlementCacheTtlMs: positiveInteger(
      'SETTLEMENT_CACHE_TTL_MS',
      env.SETTLEMENT_CACHE_TTL_MS,
      300_000,
    ),
    settlementCacheMaxEntries: positiveInteger(
      'SETTLEMENT_CACHE_MAX_ENTRIES',
      env.SETTLEMENT_CACHE_MAX_ENTRIES,
      10_000,
    ),
    shutdownTimeoutMs: positiveInteger('SHUTDOWN_TIMEOUT_MS', env.SHUTDOWN_TIMEOUT_MS, 10_000),
  };
}

/**
 * Overlays the JSON object in `FACILITATOR_SECRETS` (a whole Secrets Manager value injected as one
 * variable) onto the environment; its keys win. Errors name keys only — `JSON.parse` messages can
 * quote the input, so they are never rethrown.
 */
function withInjectedSecrets(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const raw = env.FACILITATOR_SECRETS?.trim();
  if (!raw) return env;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('FACILITATOR_SECRETS must be a JSON object');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('FACILITATOR_SECRETS must be a JSON object');
  }
  const injected: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value !== 'string') {
      throw new Error(`FACILITATOR_SECRETS.${key} must be a string`);
    }
    injected[key] = value;
  }
  return { ...env, ...injected };
}

const MIN_ADMIN_KEY_LENGTH = 32;
const MIN_REGISTRATION_IP_HASH_KEY_LENGTH = 32;

function parseRegistrationIpHashKey(env: NodeJS.ProcessEnv): string | undefined {
  const key = env.REGISTRATION_IP_HASH_KEY?.trim();
  if (!key) return undefined;
  if (key.length < MIN_REGISTRATION_IP_HASH_KEY_LENGTH) {
    throw new Error(
      `REGISTRATION_IP_HASH_KEY must be at least ${MIN_REGISTRATION_IP_HASH_KEY_LENGTH} characters`,
    );
  }
  return key;
}

/** `ADMIN_API_KEYS`: a JSON object of admin name to key. Errors name keys only, never values. */
function parseAdminApiKeys(env: NodeJS.ProcessEnv): Record<string, string> {
  const raw = env.ADMIN_API_KEYS?.trim();
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('ADMIN_API_KEYS must be a JSON object');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('ADMIN_API_KEYS must be a JSON object');
  }
  const keys: Record<string, string> = {};
  for (const [name, key] of Object.entries(parsed)) {
    if (!name.trim() || typeof key !== 'string' || key.length < MIN_ADMIN_KEY_LENGTH) {
      throw new Error(`ADMIN_API_KEYS.${name} must be at least ${MIN_ADMIN_KEY_LENGTH} characters`);
    }
    keys[name] = key;
  }
  return keys;
}

function requiredDatabaseUrl(env: NodeJS.ProcessEnv): string {
  const url = loadDatabaseUrl(env);
  if (!url) throw new Error('DATABASE_URL is required');
  return url;
}

/**
 * `DATABASE_URL`, or undefined when unset. In production a non-local database must be reached over
 * TLS that verifies the server certificate (`sslmode=verify-full`). Errors never echo the URL,
 * because it carries the database password.
 */
export function loadDatabaseUrl(rawEnv: NodeJS.ProcessEnv = process.env): string | undefined {
  const env = withInjectedSecrets(rawEnv);
  const raw = env.DATABASE_URL?.trim();
  if (!raw) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error('DATABASE_URL must be a postgres:// URL');
  }
  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
    throw new Error('DATABASE_URL must be a postgres:// URL');
  }
  const isLocal = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
  const isProduction = (env.NODE_ENV || 'development') === 'production';
  if (isProduction && !isLocal && parsed.searchParams.get('sslmode') !== 'verify-full') {
    throw new Error('DATABASE_URL must use sslmode=verify-full in production');
  }
  return raw;
}

/**
 * `CHANNEL_STORE_URL`. In production a non-local store must be reached over TLS (`rediss://`).
 * Errors never echo the URL, because it carries the store password.
 */
function channelStoreUrl(env: NodeJS.ProcessEnv): string {
  const raw = env.CHANNEL_STORE_URL?.trim();
  if (!raw) throw new Error('CHANNEL_STORE_URL is required');
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error('CHANNEL_STORE_URL must be a redis:// or rediss:// URL');
  }
  if (parsed.protocol !== 'redis:' && parsed.protocol !== 'rediss:') {
    throw new Error('CHANNEL_STORE_URL must be a redis:// or rediss:// URL');
  }
  const isLocal = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
  const isProduction = (env.NODE_ENV || 'development') === 'production';
  if (isProduction && !isLocal && parsed.protocol !== 'rediss:') {
    throw new Error('CHANNEL_STORE_URL must use rediss:// in production');
  }
  return raw;
}

function parseChannelPool(env: NodeJS.ProcessEnv): ChannelPoolConfig {
  return {
    storeUrl: channelStoreUrl(env),
    storeCommandTimeoutMs: positiveInteger(
      'CHANNEL_STORE_COMMAND_TIMEOUT_MS',
      env.CHANNEL_STORE_COMMAND_TIMEOUT_MS,
      500,
    ),
    acquireWaitMs: positiveInteger('CHANNEL_ACQUIRE_WAIT_MS', env.CHANNEL_ACQUIRE_WAIT_MS, 3_000),
    cooldownMs: positiveInteger('CHANNEL_COOLDOWN_MS', env.CHANNEL_COOLDOWN_MS, 6_000),
    unknownMarginMs: positiveInteger(
      'CHANNEL_UNKNOWN_MARGIN_MS',
      env.CHANNEL_UNKNOWN_MARGIN_MS,
      30_000,
    ),
    leaseVerifyBudgetMs: positiveInteger(
      'CHANNEL_LEASE_VERIFY_BUDGET_MS',
      env.CHANNEL_LEASE_VERIFY_BUDGET_MS,
      15_000,
    ),
    leasePollOverheadPct: positiveInteger(
      'CHANNEL_LEASE_POLL_OVERHEAD_PCT',
      env.CHANNEL_LEASE_POLL_OVERHEAD_PCT,
      50,
    ),
    leaseMarginMs: positiveInteger('CHANNEL_LEASE_MARGIN_MS', env.CHANNEL_LEASE_MARGIN_MS, 30_000),
  };
}

/** Parses and validates the environment; throws on the first invalid or missing setting. */
export function loadConfig(rawEnv: NodeJS.ProcessEnv = process.env): FacilitatorConfig {
  const env = withInjectedSecrets(rawEnv);
  const network = parseNetwork(env);
  const port = parsePort(env);
  const signing = parseSigning(env);
  if (network === 'stellar:pubnet' && !env.STELLAR_RPC_URL?.trim()) {
    throw new Error('STELLAR_RPC_URL is required on pubnet');
  }
  const bazaar = parseBazaar(env);
  const cors = env.CORS_ORIGINS?.trim() || '*';
  return {
    port,
    host: env.HOST?.trim() || '127.0.0.1',
    nodeEnv: env.NODE_ENV || 'development',
    network,
    rpcUrl: url('STELLAR_RPC_URL', env.STELLAR_RPC_URL?.trim() || TESTNET_RPC_URL),
    ...signing,
    ...parseLimits(env),
    feeBumpBid: parseFeeBumpBid(env),
    registrationIpHashKey: parseRegistrationIpHashKey(env),
    uptoKernelContract: env.X402_UPTO_KERNEL_CONTRACT?.trim() || undefined,
    ...bazaar,
    trustProxy: list(env.TRUST_PROXY || 'loopback,linklocal,uniquelocal'),
    corsOrigins: cors === '*' ? '*' : list(cors),
    databaseUrl: requiredDatabaseUrl(env),
    adminApiKeys: parseAdminApiKeys(env),
    channelPool: parseChannelPool(env),
  };
}
