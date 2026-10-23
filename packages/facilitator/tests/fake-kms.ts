import type { Keypair } from '@stellar/stellar-sdk';
import {
  ED25519_SPKI_PREFIX,
  kmsAliasFor,
  type KmsKeyRole,
} from '../src/modules/channels/kms/kms-address.js';
import type { KmsSigningClient } from '../src/modules/channels/kms/kms-signer.js';

export const spkiOf = (key: Keypair): Buffer =>
  Buffer.concat([ED25519_SPKI_PREFIX, key.rawPublicKey()]);
export const arnOf = (key: Keypair): string =>
  `arn:aws:kms:us-west-1:000000000000:key/${key.publicKey().slice(0, 12)}`;

interface FakeKmsOptions {
  /** Points the alias of this address at a different key. */
  aliasTo?: Record<string, Keypair>;
  /** Registers an address's alias under this role only; other addresses answer under any role. */
  roles?: Record<string, KmsKeyRole>;
  keySpec?: string;
  keyUsage?: string;
  /** Makes `sign` reject with this error. */
  signError?: Error;
  /** Returns this instead of a real signature. */
  badSignature?: boolean;
}

/** Named like the AWS SDK's error, which is how a missing alias is told apart. */
function notFound(keyId: string): Error {
  const error = new Error(`NotFoundException: ${keyId}`);
  error.name = 'NotFoundException';
  return error;
}

/** An in-memory KMS: aliases follow `kmsAliasFor`, signing uses the local keypair. */
export function fakeKms(keys: readonly Keypair[], options: FakeKmsOptions = {}) {
  const all = [...keys, ...Object.values(options.aliasTo ?? {})];
  const byArn = new Map(all.map((key) => [arnOf(key), key]));
  const calls: { op: 'getPublicKey' | 'sign'; keyId: string }[] = [];
  const client: KmsSigningClient = {
    async getPublicKey(keyId) {
      calls.push({ op: 'getPublicKey', keyId });
      const address = /^alias\/x402\/[a-z-]+\/(G[A-Z2-7]+)$/.exec(keyId)?.[1] ?? '';
      const registered = options.roles?.[address];
      const key =
        registered && kmsAliasFor({ role: registered, address }) !== keyId
          ? undefined
          : (options.aliasTo?.[address] ?? keys.find((k) => k.publicKey() === address));
      if (!key) throw notFound(keyId);
      return {
        keyArn: arnOf(key),
        keySpec: options.keySpec ?? 'ECC_NIST_EDWARDS25519',
        keyUsage: options.keyUsage ?? 'SIGN_VERIFY',
        publicKey: spkiOf(key),
      };
    },
    async sign(keyArn, message) {
      calls.push({ op: 'sign', keyId: keyArn });
      if (options.signError) throw options.signError;
      const key = byArn.get(keyArn);
      if (!key) throw new Error(`NotFoundException: ${keyArn}`);
      return options.badSignature ? Buffer.alloc(64) : key.sign(Buffer.from(message));
    },
  };
  return { client, calls };
}
