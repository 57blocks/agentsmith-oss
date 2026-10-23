import { Keypair } from '@stellar/stellar-sdk';
import {
  createEd25519Signer,
  getNetworkPassphrase,
  type FacilitatorStellarSigner,
} from '@x402/stellar';
import type { SettlementContexts } from '../channels/settlement-context.js';
import type { Logger } from '../../../../common/logger.js';
import type {
  FacilitatorConfig,
  KmsSigningConfig,
  SigningMode,
} from '../../../../config/facilitator.config.js';
import { createAwsKmsClient } from '../../../channels/kms/aws-kms-client.js';
import type { KmsKeyRole } from '../../../channels/kms/kms-address.js';
import {
  KmsKeyRejectedError,
  loadKmsSigner,
  type KmsSigningClient,
  type KmsStellarSigner,
} from '../../../channels/kms/kms-signer.js';

export interface SignerSetup {
  /** Where the private keys live. */
  signing: SigningMode;
  /** Pays every settlement's fee through a fee-bump; not advertised in `/supported`. */
  feeBumpSigner: FacilitatorStellarSigner;
  /** The stable key that co-signs `upto` Kernel calls; with `upto` on, `/supported`'s only signer. */
  authorizationSigner?: FacilitatorStellarSigner;
}

export interface SignerDeps {
  log: Logger;
  /** Replaces the AWS client; tests pass an in-memory KMS. */
  kms?: KmsSigningClient;
}

/** Options every scheme shares; `contexts` gives each settlement its leased channel. */
export interface SchemeOptions {
  rpcConfig: { url: string };
  maxResourceFeeStroops: number;
  contexts: SettlementContexts;
}

/**
 * Checks the configured channel addresses against the other roles. Channel signers themselves load
 * in the channel pool, per lease.
 */
function assertSeparateRoles(
  setup: Pick<SignerSetup, 'feeBumpSigner' | 'authorizationSigner'> & {
    channelAddresses: readonly string[];
  },
  hasUpto: boolean,
): void {
  const { channelAddresses: addresses, feeBumpSigner, authorizationSigner } = setup;
  if (new Set(addresses).size !== addresses.length) {
    throw new Error('Source channels contain a duplicate address');
  }
  if (addresses.includes(feeBumpSigner.address)) {
    throw new Error('Fee-bump signer must be separate from source channels');
  }
  const authAddress = authorizationSigner?.address;
  if (
    hasUpto &&
    authAddress &&
    (addresses.includes(authAddress) || authAddress === feeBumpSigner.address)
  ) {
    throw new Error('upto authorization signer must be separate from channels and fee payer');
  }
}

function feeBumpChannelSigners(config: FacilitatorConfig, feeBumpSecret: string): SignerSetup {
  const channelAddresses = config.channelSecrets.map((secret) =>
    Keypair.fromSecret(secret).publicKey(),
  );
  const feeBumpSigner = createEd25519Signer(feeBumpSecret);
  const authorizationSigner = config.privateKey
    ? createEd25519Signer(config.privateKey)
    : undefined;
  assertSeparateRoles(
    { channelAddresses, feeBumpSigner, authorizationSigner },
    Boolean(config.uptoKernelContract),
  );
  return { signing: 'env', feeBumpSigner, authorizationSigner };
}

function loadEnvSigners(config: FacilitatorConfig): SignerSetup {
  if (!config.feeBumpSecret || config.channelSecrets.length === 0) {
    throw new Error('env signing needs a fee-bump secret and at least one channel secret');
  }
  return feeBumpChannelSigners(config, config.feeBumpSecret);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown';
}

/** The address to key ARN audit trail (KMS-2); key material is never logged. */
function logLoaded(log: Logger, role: KmsRole, signer: KmsStellarSigner): void {
  log.info('kms_signer_loaded', { role, address: signer.address, keyArn: signer.keyArn });
}

/** The `role` field of the `kms_signer_*` logs; not the KMS `x402:role` tag (`KmsKeyRole`). */
type KmsRole = 'fee_payer' | 'authorization';

/** A fee payer or authorization key is required, so its failure is logged and then fatal. */
async function loadRequiredKmsSigner(
  role: KmsRole,
  address: string,
  load: (address: string) => Promise<KmsStellarSigner>,
  log: Logger,
): Promise<KmsStellarSigner> {
  try {
    const signer = await load(address);
    logLoaded(log, role, signer);
    return signer;
  } catch (error) {
    if (error instanceof KmsKeyRejectedError) {
      log.error('kms_signer_rejected', {
        role,
        address,
        reason: 'key_mismatch',
        message: error.message,
      });
    } else {
      log.error('kms_signer_unavailable', {
        role,
        address,
        reason: 'kms_error',
        message: errorMessage(error),
      });
    }
    throw error;
  }
}

async function loadKmsSigners(
  config: FacilitatorConfig,
  kms: KmsSigningConfig,
  deps: SignerDeps,
): Promise<SignerSetup> {
  const client = deps.kms ?? createAwsKmsClient(kms.region);
  const passphrase = getNetworkPassphrase(config.network);
  // Each address is looked up under the alias of the role it is configured for.
  const loadAs = (role: KmsKeyRole) => (address: string) =>
    loadKmsSigner(client, { role, address }, passphrase, deps.log);
  const feeBumpSigner = await loadRequiredKmsSigner(
    'fee_payer',
    kms.feePayerAddress,
    loadAs('fee-payer'),
    deps.log,
  );
  const authorizationSigner = kms.authorizationAddress
    ? await loadRequiredKmsSigner(
        'authorization',
        kms.authorizationAddress,
        loadAs('authorization'),
        deps.log,
      )
    : undefined;
  assertSeparateRoles(
    { channelAddresses: kms.channelAddresses, feeBumpSigner, authorizationSigner },
    Boolean(config.uptoKernelContract),
  );
  return { signing: 'kms', feeBumpSigner, authorizationSigner };
}

/** Resolves the configured keys into signer roles, rejecting keys shared across roles. */
export async function loadSigners(
  config: FacilitatorConfig,
  deps: SignerDeps,
): Promise<SignerSetup> {
  if (config.signingMode !== 'kms') return loadEnvSigners(config);
  if (!config.kms) throw new Error('kms signing mode has no KMS configuration');
  return loadKmsSigners(config, config.kms, deps);
}
