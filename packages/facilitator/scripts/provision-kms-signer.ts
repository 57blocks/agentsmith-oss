// Creates or completes one KMS-held Stellar signer: key, alias (see kmsAliasFor), tags, funding.
//
//   create --environment devnet --network testnet|pubnet --role channel|fee-payer|authorization [--balance 1.5]
//   fund   --environment devnet --network testnet|pubnet --role … --address G… [--balance 1.5]
//
// The key's alias is alias/x402/<role>/<address>. --environment is the key's x402:environment
// tag: IAM grants by it and x402:network, so only that environment's facilitator can sign with it.
//
// `fund` is idempotent: it checks the alias still resolves to the address and that the key's
// x402:network, x402:environment and x402:role tags match the flags, refuses on any mismatch, and
// creates the account only if it does not exist. Funding signs with PROVISION_FUNDER_SECRET
// (operator machine only). The region comes from --region, then AWS_REGION, then us-west-1.
//
// Pubnet funding prints funder, destination and amount and refuses unless --yes is passed.
// `fund` reads the key's tags, so the operator needs kms:ListResourceTags besides kms:GetPublicKey
// (and kms:CreateKey, kms:TagResource, kms:CreateAlias for `create`).
// Stray keys (for example after a crash mid-create) can be found by tag Project=facilitator.
import { parseArgs } from 'node:util';
import {
  CreateAliasCommand,
  CreateKeyCommand,
  GetPublicKeyCommand,
  ListResourceTagsCommand,
  KMSClient,
} from '@aws-sdk/client-kms';
import {
  Horizon,
  Keypair,
  Networks,
  Operation,
  StrKey,
  TransactionBuilder,
} from '@stellar/stellar-sdk';
import {
  addressFromSpki,
  assertKeyTags,
  assertKmsEnvironment,
  kmsAliasFor,
  type KmsKeyRef,
  type KmsKeyRole,
  type KmsTag,
} from '../src/modules/channels/kms/kms-address.js';

const ROLES: readonly KmsKeyRole[] = ['channel', 'fee-payer', 'authorization'];
const NETWORKS = {
  testnet: { passphrase: Networks.TESTNET, horizon: 'https://horizon-testnet.stellar.org' },
  pubnet: { passphrase: Networks.PUBLIC, horizon: 'https://horizon.stellar.org' },
} as const;
type NetworkName = keyof typeof NETWORKS;

const DEFAULT_BALANCE = '1.5';
const USAGE =
  'usage: provision-kms-signer.ts create|fund --environment <name> --network testnet|pubnet (see file header)';

function isNetworkName(value: string | undefined): value is NetworkName {
  return value === 'testnet' || value === 'pubnet';
}

function isRole(value: string | undefined): value is KmsKeyRole {
  return (ROLES as readonly string[]).includes(value ?? '');
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface Ctx {
  environment: string;
  kms: KMSClient;
  horizon: Horizon.Server;
  networkName: NetworkName;
  passphrase: string;
  balance: string;
  yes: boolean;
}

function isNotFound(error: unknown): boolean {
  return (error as { response?: { status?: number } }).response?.status === 404;
}

// Horizon result codes only; never the envelope or the raw error object.
function resultCodesOf(error: unknown): string {
  const codes = (error as { response?: { data?: { extras?: { result_codes?: unknown } } } })
    .response?.data?.extras?.result_codes;
  return codes === undefined ? '' : ` ${JSON.stringify(codes)}`;
}

async function addressOfKey(ctx: Ctx, keyId: string): Promise<string> {
  const { PublicKey } = await ctx.kms.send(new GetPublicKeyCommand({ KeyId: keyId }));
  if (!PublicKey) throw new Error(`KMS returned no public key for ${keyId}`);
  return addressFromSpki(PublicKey);
}

async function createKey(ctx: Ctx, role: KmsKeyRole): Promise<string> {
  const created = await ctx.kms.send(
    new CreateKeyCommand({
      KeySpec: 'ECC_NIST_EDWARDS25519',
      KeyUsage: 'SIGN_VERIFY',
      Description: `x402 facilitator ${ctx.environment} ${ctx.networkName} ${role}`,
      Tags: [
        { TagKey: 'Project', TagValue: 'facilitator' },
        { TagKey: 'x402:network', TagValue: ctx.networkName },
        { TagKey: 'x402:environment', TagValue: ctx.environment },
        { TagKey: 'x402:role', TagValue: role },
      ],
    }),
  );
  const keyId = created.KeyMetadata?.KeyId;
  const keyArn = created.KeyMetadata?.Arn ?? keyId;
  if (!keyId) throw new Error('KMS returned no key id');
  // From here on a key exists; any failure must name it so the operator can schedule deletion.
  try {
    const address = await addressOfKey(ctx, keyId);
    await ctx.kms.send(
      new CreateAliasCommand({ AliasName: kmsAliasFor({ role, address }), TargetKeyId: keyId }),
    );
    return address;
  } catch (error) {
    throw new Error(
      `KEY ${keyArn} was created and may have no alias; check ` +
        `\`aws kms list-aliases --key-id ${keyArn}\` before scheduling its deletion ` +
        `(aws kms schedule-key-deletion --key-id ${keyId}): ${messageOf(error)}`,
    );
  }
}

async function listTags(ctx: Ctx, keyArn: string): Promise<KmsTag[]> {
  const tags: KmsTag[] = [];
  let marker: string | undefined;
  do {
    const page = await ctx.kms.send(new ListResourceTagsCommand({ KeyId: keyArn, Marker: marker }));
    tags.push(...(page.Tags ?? []));
    marker = page.Truncated ? page.NextMarker : undefined;
  } while (marker);
  return tags;
}

// The alias carries no environment, so the tags are what tie the key to this run's flags.
async function assertKeyTagsMatch(ctx: Ctx, keyArn: string, role: KmsKeyRole): Promise<void> {
  try {
    assertKeyTags(keyArn, await listTags(ctx, keyArn), {
      'x402:network': ctx.networkName,
      'x402:environment': ctx.environment,
      'x402:role': role,
    });
  } catch (error) {
    throw new Error(`refusing to fund: ${messageOf(error)}`);
  }
}

async function assertAlias(ctx: Ctx, ref: KmsKeyRef): Promise<void> {
  if (!StrKey.isValidEd25519PublicKey(ref.address))
    throw new Error('--address is not a Stellar G… address');
  const alias = kmsAliasFor(ref);
  const { PublicKey, KeyId } = await ctx.kms.send(new GetPublicKeyCommand({ KeyId: alias }));
  if (!PublicKey || !KeyId) throw new Error(`KMS returned no public key for ${alias}`);
  if (addressFromSpki(PublicKey) !== ref.address) throw new Error(`${alias} points at another key`);
  await assertKeyTagsMatch(ctx, KeyId, ref.role);
}

async function accountExists(ctx: Ctx, address: string): Promise<boolean> {
  try {
    await ctx.horizon.loadAccount(address);
    return true;
  } catch (error) {
    if (isNotFound(error)) return false;
    throw error;
  }
}

async function fund(ctx: Ctx, address: string): Promise<void> {
  if (await accountExists(ctx, address)) {
    console.log(`${address} already exists; not funded again`);
    return;
  }
  const secret = process.env.PROVISION_FUNDER_SECRET;
  if (!secret) throw new Error('PROVISION_FUNDER_SECRET is required to fund a new account');
  const funder = Keypair.fromSecret(secret);
  if (ctx.networkName === 'pubnet') {
    console.log(
      `pubnet funding: ${funder.publicKey()} -> ${address}, ${ctx.balance} XLM, network pubnet`,
    );
    if (!ctx.yes) throw new Error('refusing to fund on pubnet without --yes');
  }
  let funderAccount;
  try {
    funderAccount = await ctx.horizon.loadAccount(funder.publicKey());
  } catch (error) {
    if (isNotFound(error))
      throw new Error(`funder ${funder.publicKey()} not found on ${ctx.networkName}`);
    throw error;
  }
  const tx = new TransactionBuilder(funderAccount, {
    fee: '1000',
    networkPassphrase: ctx.passphrase,
  })
    .addOperation(Operation.createAccount({ destination: address, startingBalance: ctx.balance }))
    .setTimeout(60)
    .build();
  tx.sign(funder);
  try {
    const result = await ctx.horizon.submitTransaction(tx);
    console.log(`funded ${address} with ${ctx.balance} XLM in ${result.hash}`);
  } catch (error) {
    throw new Error(`submit failed: ${messageOf(error)}${resultCodesOf(error)}`);
  }
}

function rerunHint(ctx: Ctx, { role, address }: KmsKeyRef): string {
  const flags = [
    `--environment ${ctx.environment}`,
    `--network ${ctx.networkName}`,
    `--role ${role}`,
    `--address ${address}`,
  ];
  if (ctx.balance !== DEFAULT_BALANCE) flags.push(`--balance ${ctx.balance}`);
  if (ctx.networkName === 'pubnet') flags.push('--yes');
  return `pnpm kms:provision fund ${flags.join(' ')}`;
}

async function create(ctx: Ctx, role: string | undefined): Promise<void> {
  if (!isRole(role)) throw new Error(`--role must be one of ${ROLES.join(', ')}`);
  if (ctx.networkName === 'pubnet' && !ctx.yes) {
    console.log(
      `would create a ${role} KMS key (alias ${kmsAliasFor({ role, address: '<address>' })}) and fund it with ${ctx.balance} XLM on pubnet`,
    );
    throw new Error('refusing to create a pubnet key without --yes; no key was created');
  }
  const address = await createKey(ctx, role);
  console.log(`created ${kmsAliasFor({ role, address })}`);
  try {
    await fund(ctx, address);
  } catch (error) {
    throw new Error(
      `key and alias for ${address} exist but funding failed or is unconfirmed: ${messageOf(error)}\n` +
        `Wait at least 60 s (the transaction time bound), check the account, then re-run:\n` +
        `${rerunHint(ctx, { role, address })}`,
    );
  }
  console.log(address);
}

async function main(): Promise<void> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      environment: { type: 'string' },
      network: { type: 'string' },
      role: { type: 'string' },
      address: { type: 'string' },
      balance: { type: 'string', default: DEFAULT_BALANCE },
      yes: { type: 'boolean', default: false },
      region: { type: 'string', default: process.env.AWS_REGION ?? 'us-west-1' },
    },
  });
  const command = positionals[0];
  if (command !== 'create' && command !== 'fund') throw new Error(USAGE);
  const environment = values.environment?.trim();
  if (!environment) throw new Error('--environment is required (e.g. devnet)');
  assertKmsEnvironment('--environment', environment);
  if (!isNetworkName(values.network)) throw new Error('--network must be testnet or pubnet');
  const balance = values.balance ?? DEFAULT_BALANCE;
  if (!/^\d+(\.\d{1,7})?$/.test(balance) || Number(balance) <= 0) {
    throw new Error('--balance must be a positive XLM amount with at most 7 decimals');
  }
  const network = NETWORKS[values.network];
  const ctx: Ctx = {
    environment,
    kms: new KMSClient({ region: values.region }),
    horizon: new Horizon.Server(network.horizon),
    networkName: values.network,
    passphrase: network.passphrase,
    balance,
    yes: values.yes ?? false,
  };

  if (command === 'create') return create(ctx, values.role);
  if (!values.address) throw new Error('--address is required');
  if (!isRole(values.role)) throw new Error(`--role must be one of ${ROLES.join(', ')}`);
  await assertAlias(ctx, { role: values.role, address: values.address });
  await fund(ctx, values.address);
}

main().catch((error: unknown) => {
  console.error(messageOf(error));
  process.exitCode = 1;
});
