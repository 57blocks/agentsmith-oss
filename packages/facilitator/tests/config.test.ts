import { Keypair } from '@stellar/stellar-sdk';
import { describe, expect, it } from 'vitest';
import { loadConfig, loadDatabaseUrl } from '../src/config/facilitator.config.js';
import { TEST_DATABASE_URL } from './test-env.js';

const STORE_URL = 'redis://127.0.0.1:6379';

function env(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    CHANNEL_STORE_URL: STORE_URL,
    FACILITATOR_STELLAR_FEE_BUMP_SECRET: 'S_FEE',
    FACILITATOR_STELLAR_CHANNEL_SECRETS: 'S_CHANNEL',
    DATABASE_URL: TEST_DATABASE_URL,
    ...overrides,
  };
}

describe('facilitator configuration', () => {
  it('defaults to a testnet facilitator', () => {
    const config = loadConfig(env());
    expect(config.network).toBe('stellar:testnet');
    expect(config.rpcUrl).toBe('https://soroban-testnet.stellar.org');
    expect(config.maxResourceFeeStroops).toBe(60_000);
  });

  it('does not start without a database', () => {
    expect(() => loadConfig(env({ DATABASE_URL: '' }))).toThrow(/DATABASE_URL is required/);
  });

  it('fails closed when no signer configuration exists', () => {
    expect(() => loadConfig({})).toThrow(/FACILITATOR_STELLAR_FEE_BUMP_SECRET/);
  });

  it('requires a fee payer and at least one channel', () => {
    expect(() => loadConfig(env({ FACILITATOR_STELLAR_CHANNEL_SECRETS: '' }))).toThrow(
      /FEE_BUMP_SECRET and FACILITATOR_STELLAR_CHANNEL_SECRETS are required/,
    );
    expect(() => loadConfig(env({ FACILITATOR_STELLAR_FEE_BUMP_SECRET: '' }))).toThrow(
      /FEE_BUMP_SECRET and FACILITATOR_STELLAR_CHANNEL_SECRETS are required/,
    );
  });

  it('rejects a single-signer configuration and says the mode was removed', () => {
    expect(() =>
      loadConfig({
        DATABASE_URL: TEST_DATABASE_URL,
        FACILITATOR_STELLAR_PRIVATE_KEY: 'S_SINGLE',
      }),
    ).toThrow(/single-signer mode .* was removed/);
  });

  it('needs no private key when upto is off', () => {
    const config = loadConfig({
      DATABASE_URL: TEST_DATABASE_URL,
      CHANNEL_STORE_URL: STORE_URL,
      FACILITATOR_STELLAR_FEE_BUMP_SECRET: 'S_FEE',
      FACILITATOR_STELLAR_CHANNEL_SECRETS: 'S_ONE, S_TWO',
    });
    expect(config.privateKey).toBeUndefined();
    expect(config.channelSecrets).toEqual(['S_ONE', 'S_TWO']);
  });

  it('requires a fixed authorization signer when upto uses channels', () => {
    expect(() =>
      loadConfig({
        DATABASE_URL: TEST_DATABASE_URL,
        FACILITATOR_STELLAR_FEE_BUMP_SECRET: 'S_FEE',
        FACILITATOR_STELLAR_CHANNEL_SECRETS: 'S_ONE,S_TWO',
        X402_UPTO_KERNEL_CONTRACT: 'C_KERNEL',
      }),
    ).toThrow(/PRIVATE_KEY/);
  });

  it('requires an explicit RPC provider on pubnet', () => {
    expect(() =>
      loadConfig(
        env({
          STELLAR_NETWORK: 'stellar:pubnet',
        }),
      ),
    ).toThrow(/STELLAR_RPC_URL/);
  });

  it('rejects unsupported networks and insecure remote RPC URLs', () => {
    expect(() => loadConfig(env({ STELLAR_NETWORK: 'eip155:84532' }))).toThrow(/STELLAR_NETWORK/);
    expect(() => loadConfig(env({ STELLAR_RPC_URL: 'http://rpc.example.com' }))).toThrow(/HTTPS/);
  });

  it('requires a token for the optional Bazaar settlement callback', () => {
    expect(() =>
      loadConfig(
        env({
          BAZAAR_SETTLEMENT_URL: 'http://127.0.0.1:8402/discovery/settlements',
        }),
      ),
    ).toThrow(/BAZAAR_SETTLEMENT_API_KEY/);
    expect(
      loadConfig(
        env({
          BAZAAR_SETTLEMENT_URL: 'http://127.0.0.1:8402/discovery/settlements',
          BAZAAR_SETTLEMENT_API_KEY: 'bazaar-secret',
        }),
      ).bazaarSettlementUrl,
    ).toBe('http://127.0.0.1:8402/discovery/settlements');
  });

  it('allows an HTTP Bazaar callback on a Docker development network', () => {
    expect(
      loadConfig(
        env({
          NODE_ENV: 'development',
          BAZAAR_SETTLEMENT_URL: 'http://bazaar:8402/discovery/settlements',
          BAZAAR_SETTLEMENT_API_KEY: 'bazaar-secret',
        }),
      ).bazaarSettlementUrl,
    ).toBe('http://bazaar:8402/discovery/settlements');
  });

  it('still requires HTTPS for a Docker-style Bazaar host in production', () => {
    expect(() =>
      loadConfig(
        kmsEnv({
          NODE_ENV: 'production',
          BAZAAR_SETTLEMENT_URL: 'http://bazaar:8402/discovery/settlements',
          BAZAAR_SETTLEMENT_API_KEY: 'bazaar-secret',
        }),
      ),
    ).toThrow(/HTTPS/);
  });
});

describe('ADMIN_API_KEYS', () => {
  it('reads named admin keys, and none when unset', () => {
    const key = 'k'.repeat(32);
    expect(
      loadConfig(env({ ADMIN_API_KEYS: JSON.stringify({ alice: key }) })).adminApiKeys,
    ).toEqual({ alice: key });
    expect(loadConfig(env()).adminApiKeys).toEqual({});
  });

  it('refuses a key shorter than 32 characters or a value that is not an object, without echoing it', () => {
    const short = () => loadConfig(env({ ADMIN_API_KEYS: '{"alice":"S_SHORT"}' }));
    expect(short).toThrow(/ADMIN_API_KEYS\.alice must be at least 32 characters/);
    expect(short).not.toThrow(/S_SHORT/);
    expect(() => loadConfig(env({ ADMIN_API_KEYS: '["x"]' }))).toThrow(
      /ADMIN_API_KEYS must be a JSON object/,
    );
  });
});

describe('FACILITATOR_SECRETS', () => {
  const secrets = (value: unknown) => JSON.stringify(value);

  it('reads settings from the injected JSON object', () => {
    const config = loadConfig({
      DATABASE_URL: TEST_DATABASE_URL,
      CHANNEL_STORE_URL: STORE_URL,
      FACILITATOR_SECRETS: secrets({
        FACILITATOR_STELLAR_FEE_BUMP_SECRET: 'S_FEE_FROM_SECRET',
        FACILITATOR_STELLAR_CHANNEL_SECRETS: 'S_CHANNEL_FROM_SECRET',
        MAX_RESOURCE_FEE_STROOPS: '75000',
      }),
    });
    expect(config.feeBumpSecret).toBe('S_FEE_FROM_SECRET');
    expect(config.channelSecrets).toEqual(['S_CHANNEL_FROM_SECRET']);
    expect(config.maxResourceFeeStroops).toBe(75_000);
  });

  it('accepts any key, not only secrets', () => {
    const config = loadConfig(
      env({ FACILITATOR_SECRETS: secrets({ MAX_RESOURCE_FEE_STROOPS: '200000' }) }),
    );
    expect(config.maxResourceFeeStroops).toBe(200_000);
  });

  it('falls back to the default for a key the secret does not hold', () => {
    const config = loadConfig({
      DATABASE_URL: TEST_DATABASE_URL,
      CHANNEL_STORE_URL: STORE_URL,
      FACILITATOR_SECRETS: secrets({
        FACILITATOR_STELLAR_FEE_BUMP_SECRET: 'S_FEE_FROM_SECRET',
        FACILITATOR_STELLAR_CHANNEL_SECRETS: 'S_CHANNEL_FROM_SECRET',
      }),
    });
    expect(config.network).toBe('stellar:testnet');
    expect(config.maxResourceFeeStroops).toBe(60_000);
  });

  it('overrides a plain environment variable of the same name', () => {
    const config = loadConfig(
      env({
        MAX_RESOURCE_FEE_STROOPS: '60000',
        FACILITATOR_SECRETS: secrets({ MAX_RESOURCE_FEE_STROOPS: '70000' }),
      }),
    );
    expect(config.maxResourceFeeStroops).toBe(70_000);
  });

  it('treats an empty value as unset', () => {
    expect(loadConfig(env({ FACILITATOR_SECRETS: '  ' })).maxResourceFeeStroops).toBe(60_000);
  });

  it('rejects malformed JSON without echoing its contents', () => {
    const run = () => loadConfig(env({ FACILITATOR_SECRETS: '{"DATABASE_URL":"S_LEAK' }));
    expect(run).toThrow(/FACILITATOR_SECRETS must be a JSON object/);
    expect(run).not.toThrow(/S_LEAK/);
  });

  it('rejects JSON that is not an object', () => {
    expect(() => loadConfig(env({ FACILITATOR_SECRETS: secrets(['S_ONE']) }))).toThrow(
      /FACILITATOR_SECRETS must be a JSON object/,
    );
  });

  it('rejects a non-string value, naming the key but not the value', () => {
    const run = () => loadConfig(env({ FACILITATOR_SECRETS: secrets({ RATE_LIMIT_MAX: 987654 }) }));
    expect(run).toThrow(/FACILITATOR_SECRETS\.RATE_LIMIT_MAX must be a string/);
    expect(run).not.toThrow(/987654/);
  });
});

describe('fee settings', () => {
  it('no longer reads the fee ceiling under its former name', () => {
    const config = loadConfig(env({ MAX_TRANSACTION_FEE_STROOPS: '200000' }));
    expect(config.maxResourceFeeStroops).toBe(60_000);
  });

  it('bids 1.5 times the median, capped at 2,000 stroops, by default', () => {
    expect(loadConfig(env()).feeBumpBid).toEqual({ multiplier: 1.5, maxBidStroops: 2_000 });
  });

  it('reads the bid multiplier and cap', () => {
    const config = loadConfig(
      env({ FEE_BUMP_BID_MULTIPLIER: '2.25', MAX_FEE_BUMP_BID_STROOPS: '5000' }),
    );
    expect(config.feeBumpBid).toEqual({ multiplier: 2.25, maxBidStroops: 5_000 });
  });

  it.each(['0', '-1', 'two'])('rejects the bid multiplier %j', (value) => {
    expect(() => loadConfig(env({ FEE_BUMP_BID_MULTIPLIER: value }))).toThrow(
      'FEE_BUMP_BID_MULTIPLIER must be a positive number',
    );
  });

  it('rejects a bid cap below the network minimum of 100 stroops', () => {
    expect(() => loadConfig(env({ MAX_FEE_BUMP_BID_STROOPS: '99' }))).toThrow(
      'MAX_FEE_BUMP_BID_STROOPS must be at least 100',
    );
  });
});

describe('DATABASE_URL', () => {
  it('accepts a postgres URL, including one injected through FACILITATOR_SECRETS', () => {
    const url = 'postgres://facilitator:pw@db.internal:5432/facilitator';
    expect(loadConfig(env({ DATABASE_URL: url })).databaseUrl).toBe(url);
    expect(loadDatabaseUrl({ FACILITATOR_SECRETS: JSON.stringify({ DATABASE_URL: url }) })).toBe(
      url,
    );
  });

  it('rejects a non-postgres URL without echoing the password', () => {
    const run = () =>
      loadDatabaseUrl({ DATABASE_URL: 'mysql://facilitator:S3CRET@db/facilitator' });
    expect(run).toThrow(/DATABASE_URL must be a postgres:\/\/ URL/);
    expect(run).not.toThrow(/S3CRET/);
  });

  it('requires certificate-verifying TLS for a remote database in production', () => {
    const remote = 'postgres://facilitator:S3CRET@db.internal:5432/facilitator';
    const run = () => loadDatabaseUrl({ NODE_ENV: 'production', DATABASE_URL: remote });
    expect(run).toThrow(/sslmode=verify-full/);
    expect(run).not.toThrow(/S3CRET/);
    expect(() =>
      loadDatabaseUrl({ NODE_ENV: 'production', DATABASE_URL: `${remote}?sslmode=require` }),
    ).toThrow(/sslmode=verify-full/);
    expect(
      loadDatabaseUrl({ NODE_ENV: 'production', DATABASE_URL: `${remote}?sslmode=verify-full` }),
    ).toContain('sslmode=verify-full');
  });

  it('allows a local database without TLS, in production too', () => {
    const local = 'postgres://facilitator:facilitator@127.0.0.1:5432/facilitator';
    expect(loadDatabaseUrl({ NODE_ENV: 'production', DATABASE_URL: local })).toBe(local);
  });
});

const address = () => Keypair.random().publicKey();

function kmsEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    DATABASE_URL: TEST_DATABASE_URL,
    CHANNEL_STORE_URL: STORE_URL,
    FACILITATOR_SIGNING_MODE: 'kms',
    FACILITATOR_KMS_REGION: 'us-west-1',
    FACILITATOR_KMS_FEE_PAYER_ADDRESS: address(),
    FACILITATOR_KMS_CHANNEL_ADDRESSES: `${address()},${address()}`,
    ...overrides,
  };
}

describe('KMS signing mode', () => {
  it('refuses environment keys in production, where deployed networks sign with KMS', () => {
    expect(() => loadConfig(env({ NODE_ENV: 'production' }))).toThrow(
      /FACILITATOR_SIGNING_MODE=env is not allowed when NODE_ENV=production/,
    );
    expect(() =>
      loadConfig(env({ NODE_ENV: 'production', FACILITATOR_SIGNING_MODE: 'env' })),
    ).toThrow(/use kms/);
  });

  it('accepts KMS signing in production', () => {
    expect(loadConfig(kmsEnv({ NODE_ENV: 'production' })).signingMode).toBe('kms');
  });

  it('keeps environment keys for local development', () => {
    expect(loadConfig(env({ NODE_ENV: 'development' })).signingMode).toBe('env');
    expect(loadConfig(env({ NODE_ENV: 'test' })).signingMode).toBe('env');
  });

  it('defaults to environment keys', () => {
    expect(loadConfig(env()).signingMode).toBe('env');
  });

  it('reads addresses and region in kms mode', () => {
    const config = loadConfig(kmsEnv());
    expect(config.signingMode).toBe('kms');
    expect(config.kms?.region).toBe('us-west-1');
    expect(config.kms?.channelAddresses).toHaveLength(2);
  });

  it('falls back to AWS_REGION', () => {
    expect(
      loadConfig(kmsEnv({ FACILITATOR_KMS_REGION: '', AWS_REGION: 'us-east-2' })).kms?.region,
    ).toBe('us-east-2');
  });

  it('refuses any seed in kms mode', () => {
    expect(() => loadConfig(kmsEnv({ FACILITATOR_STELLAR_FEE_BUMP_SECRET: 'S_X' }))).toThrow(
      /FACILITATOR_STELLAR_FEE_BUMP_SECRET must not be set/,
    );
  });

  it('requires a fee payer and at least one channel', () => {
    expect(() => loadConfig(kmsEnv({ FACILITATOR_KMS_FEE_PAYER_ADDRESS: '' }))).toThrow(
      /FEE_PAYER_ADDRESS/,
    );
    expect(() => loadConfig(kmsEnv({ FACILITATOR_KMS_CHANNEL_ADDRESSES: '' }))).toThrow(
      /CHANNEL_ADDRESSES/,
    );
  });

  it('requires an authorization address when upto is enabled', () => {
    expect(() => loadConfig(kmsEnv({ X402_UPTO_KERNEL_CONTRACT: 'C_KERNEL' }))).toThrow(
      /AUTHORIZATION_ADDRESS/,
    );
  });

  it('rejects an authorization address when upto is not configured', () => {
    expect(() => loadConfig(kmsEnv({ FACILITATOR_KMS_AUTHORIZATION_ADDRESS: address() }))).toThrow(
      'FACILITATOR_KMS_AUTHORIZATION_ADDRESS is only used with X402_UPTO_KERNEL_CONTRACT',
    );
  });

  it('rejects a value that is not a G address', () => {
    expect(() =>
      loadConfig(kmsEnv({ FACILITATOR_KMS_CHANNEL_ADDRESSES: 'not-an-address' })),
    ).toThrow(/FACILITATOR_KMS_CHANNEL_ADDRESSES/);
  });

  it('rejects an unknown mode', () => {
    expect(() => loadConfig(env({ FACILITATOR_SIGNING_MODE: 'hsm' }))).toThrow(
      /FACILITATOR_SIGNING_MODE/,
    );
  });

  it('reads a valid authorization address when upto is enabled', () => {
    const authorization = address();
    const config = loadConfig(
      kmsEnv({
        X402_UPTO_KERNEL_CONTRACT: 'C_KERNEL',
        FACILITATOR_KMS_AUTHORIZATION_ADDRESS: authorization,
      }),
    );
    expect(config.kms?.authorizationAddress).toBe(authorization);
  });

  it('rejects an invalid fee payer or authorization address', () => {
    expect(() => loadConfig(kmsEnv({ FACILITATOR_KMS_FEE_PAYER_ADDRESS: 'nope' }))).toThrow(
      /FACILITATOR_KMS_FEE_PAYER_ADDRESS must be a Stellar G address/,
    );
    expect(() =>
      loadConfig(
        kmsEnv({
          X402_UPTO_KERNEL_CONTRACT: 'C_KERNEL',
          FACILITATOR_KMS_AUTHORIZATION_ADDRESS: 'nope',
        }),
      ),
    ).toThrow(/FACILITATOR_KMS_AUTHORIZATION_ADDRESS must be a Stellar G address/);
  });

  it('leaves seed settings empty in kms mode', () => {
    const config = loadConfig(kmsEnv());
    expect(config.privateKey).toBeUndefined();
    expect(config.feeBumpSecret).toBeUndefined();
    expect(config.channelSecrets).toEqual([]);
  });

  it('prefers FACILITATOR_KMS_REGION over AWS_REGION', () => {
    expect(loadConfig(kmsEnv({ AWS_REGION: 'us-east-2' })).kms?.region).toBe('us-west-1');
  });

  it('parses a padded channel list', () => {
    const [a, b] = [address(), address()];
    const config = loadConfig(kmsEnv({ FACILITATOR_KMS_CHANNEL_ADDRESSES: ` ${a} , ${b} ,` }));
    expect(config.kms?.channelAddresses).toEqual([a, b]);
  });

  it('ignores FACILITATOR_KMS_ENVIRONMENT: the environment is a key tag, not config', () => {
    expect(() => loadConfig(kmsEnv({ FACILITATOR_KMS_ENVIRONMENT: 'Not Valid' }))).not.toThrow();
  });
});

describe('channel pool configuration', () => {
  it('uses the documented defaults', () => {
    expect(loadConfig(env()).channelPool).toEqual({
      storeUrl: STORE_URL,
      storeCommandTimeoutMs: 500,
      acquireWaitMs: 3_000,
      cooldownMs: 6_000,
      unknownMarginMs: 30_000,
      leaseVerifyBudgetMs: 15_000,
      leasePollOverheadPct: 50,
      leaseMarginMs: 30_000,
    });
  });

  it('requires a store', () => {
    expect(() => loadConfig(env({ CHANNEL_STORE_URL: '' }))).toThrow(
      /CHANNEL_STORE_URL is required/,
    );
  });

  it('reads the acquire wait and lease settings', () => {
    const pool = loadConfig(
      env({
        CHANNEL_ACQUIRE_WAIT_MS: '1000',
        CHANNEL_LEASE_VERIFY_BUDGET_MS: '5000',
        CHANNEL_LEASE_POLL_OVERHEAD_PCT: '25',
        CHANNEL_LEASE_MARGIN_MS: '10000',
      }),
    ).channelPool;
    expect(pool).toMatchObject({
      acquireWaitMs: 1_000,
      leaseVerifyBudgetMs: 5_000,
      leasePollOverheadPct: 25,
      leaseMarginMs: 10_000,
    });
  });

  it('accepts redis:// and rediss:// store URLs', () => {
    for (const url of ['redis://127.0.0.1:6379/0', 'rediss://:token@cache.example.com:6379/0']) {
      expect(loadConfig(env({ CHANNEL_STORE_URL: url })).channelPool.storeUrl).toBe(url);
    }
  });

  it('takes the store URL from FACILITATOR_SECRETS', () => {
    const url = 'rediss://:token@cache.example.com:6379/0';
    const config = loadConfig(
      env({ FACILITATOR_SECRETS: JSON.stringify({ CHANNEL_STORE_URL: url }) }),
    );
    expect(config.channelPool.storeUrl).toBe(url);
  });

  it('rejects another scheme without echoing the password', () => {
    const run = () =>
      loadConfig(env({ CHANNEL_STORE_URL: 'http://:S3CRET@cache.example.com:6379' }));
    expect(run).toThrow(/CHANNEL_STORE_URL must be a redis:\/\/ or rediss:\/\/ URL/);
    expect(run).not.toThrow(/S3CRET/);
  });

  it('requires TLS for a non-local store in production', () => {
    const remote = 'redis://:S3CRET@cache.example.com:6379/0';
    const run = () => loadConfig(kmsEnv({ NODE_ENV: 'production', CHANNEL_STORE_URL: remote }));
    expect(run).toThrow(/rediss:\/\/ in production/);
    expect(run).not.toThrow(/S3CRET/);
    const local = 'redis://127.0.0.1:6379/0';
    const config = loadConfig(kmsEnv({ NODE_ENV: 'production', CHANNEL_STORE_URL: local }));
    expect(config.channelPool.storeUrl).toBe(local);
  });

  it('rejects a non-positive cooldown', () => {
    expect(() => loadConfig(env({ CHANNEL_COOLDOWN_MS: '0' }))).toThrow(/CHANNEL_COOLDOWN_MS/);
  });
});

describe('REGISTRATION_IP_HASH_KEY', () => {
  it('reads the key, and none when unset', () => {
    const key = 'r'.repeat(32);
    expect(loadConfig(env({ REGISTRATION_IP_HASH_KEY: key })).registrationIpHashKey).toBe(key);
    expect(loadConfig(env()).registrationIpHashKey).toBeUndefined();
  });

  it('refuses a key shorter than 32 characters without echoing it', () => {
    const short = () => loadConfig(env({ REGISTRATION_IP_HASH_KEY: 'S_SHORT' }));
    expect(short).toThrow(/REGISTRATION_IP_HASH_KEY must be at least 32 characters/);
    expect(short).not.toThrow(/S_SHORT/);
  });
});
