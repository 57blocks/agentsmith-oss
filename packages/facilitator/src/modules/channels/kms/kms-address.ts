import { StrKey } from '@stellar/stellar-sdk';

// DER header of an Ed25519 SubjectPublicKeyInfo (RFC 8410); the raw 32-byte key follows it.
export const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

export function addressFromSpki(spki: Uint8Array): string {
  const der = Buffer.from(spki);
  if (der.length !== 44 || !der.subarray(0, 12).equals(ED25519_SPKI_PREFIX)) {
    throw new Error('KMS public key is not an Ed25519 SubjectPublicKeyInfo');
  }
  return StrKey.encodeEd25519PublicKey(der.subarray(12));
}

/**
 * A key's role; also the value of its `x402:role` tag.
 * - `channel`: a pooled channel account; it is the settlement transaction's source and signs it.
 * - `fee-payer`: signs the fee-bump around that transaction, paying the network fee.
 * - `authorization`: the `upto` key that signs the Kernel contract's `facilitator` authorization on
 *   settle; only `upto` deployments have one.
 */
export type KmsKeyRole = 'channel' | 'fee-payer' | 'authorization';

export interface KmsKeyRef {
  role: KmsKeyRole;
  address: string;
}

const ENVIRONMENT_NAME = /^[a-z0-9-]+$/;

/**
 * Checks a deployment name for use as a key's `x402:environment` tag; `name` is the setting it
 * came from. IAM grants by that tag, so one environment cannot sign with another's keys.
 */
export function assertKmsEnvironment(name: string, value: string): string {
  if (!ENVIRONMENT_NAME.test(value)) {
    throw new Error(`${name} must contain only lowercase letters, digits and -`);
  }
  return value;
}

export interface KmsTag {
  TagKey?: string;
  TagValue?: string;
}

/**
 * Checks that a key carries every `expected` tag with the expected value (e.g. `x402:network`,
 * `x402:environment`, `x402:role`); names every missing or mismatched tag in one error.
 */
export function assertKeyTags(
  keyName: string,
  tags: readonly KmsTag[],
  expected: Readonly<Record<string, string>>,
): void {
  const problems: string[] = [];
  for (const [key, want] of Object.entries(expected)) {
    const tag = tags.find((t) => t.TagKey === key);
    if (!tag) problems.push(`${keyName} has no ${key} tag (expected ${want})`);
    else if (tag.TagValue !== want) {
      problems.push(`${keyName} is tagged ${key}=${tag.TagValue ?? ''}, not ${want}`);
    }
  }
  if (problems.length > 0) throw new Error(problems.join('; '));
}

// The `upto` authorization key is the address Buyers authorize as `facilitator`, so its alias says so.
const ALIAS_SEGMENT: Readonly<Record<KmsKeyRole, string>> = {
  channel: 'channel',
  'fee-payer': 'fee-payer',
  authorization: 'facilitator',
};

export function kmsAliasFor({ role, address }: KmsKeyRef): string {
  return `alias/x402/${ALIAS_SEGMENT[role]}/${address}`;
}
