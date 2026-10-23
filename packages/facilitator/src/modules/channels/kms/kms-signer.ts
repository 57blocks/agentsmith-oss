import { Keypair, TransactionBuilder, hash } from '@stellar/stellar-sdk';
import type { FacilitatorStellarSigner } from '@x402/stellar';
import type { Logger } from '../../../common/logger.js';
import { addressFromSpki, kmsAliasFor, type KmsKeyRef } from './kms-address.js';

export interface KmsPublicKey {
  keyArn: string;
  keySpec?: string;
  keyUsage?: string;
  publicKey: Uint8Array;
}

/** The two KMS operations a signer needs; `aws-kms-client.ts` binds them to the AWS SDK. */
export interface KmsSigningClient {
  getPublicKey(keyId: string): Promise<KmsPublicKey>;
  /** Pure Ed25519 over `message` (`ED25519_SHA_512`, `MessageType=RAW`). */
  sign(keyArn: string, message: Uint8Array): Promise<Uint8Array>;
}

export interface KmsStellarSigner extends FacilitatorStellarSigner {
  readonly keyArn: string;
}

export class KmsKeyRejectedError extends Error {
  override name = 'KmsKeyRejectedError';
}

const SIGNING_FAILED = -1;

function walletError(error: unknown) {
  return {
    message: error instanceof Error ? error.message : 'KMS signing failed',
    code: SIGNING_FAILED,
  };
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'unknown';
}

async function checkedKey(client: KmsSigningClient, expected: KmsKeyRef): Promise<KmsPublicKey> {
  const alias = kmsAliasFor(expected);
  const key = await client.getPublicKey(alias);
  if (key.keySpec !== 'ECC_NIST_EDWARDS25519' || key.keyUsage !== 'SIGN_VERIFY') {
    throw new KmsKeyRejectedError(`${alias} is not an ECC_NIST_EDWARDS25519 SIGN_VERIFY key`);
  }
  let actual: string;
  try {
    actual = addressFromSpki(key.publicKey);
  } catch {
    throw new KmsKeyRejectedError(`${alias} has a malformed public key`);
  }
  if (actual !== expected.address) {
    throw new KmsKeyRejectedError(`${alias} resolves to ${actual}`);
  }
  return key;
}

interface SigningContext {
  client: KmsSigningClient;
  address: string;
  keyArn: string;
  log?: Logger;
}

async function signPayload(ctx: SigningContext, payload: Buffer): Promise<Buffer> {
  const signature = Buffer.from(await ctx.client.sign(ctx.keyArn, payload));
  if (!Keypair.fromPublicKey(ctx.address).verify(payload, signature)) {
    throw new Error(`KMS signature does not verify for ${ctx.address}`);
  }
  return signature;
}

/** Records why a signature failed: identity and error only, never the payload or signature. */
function failed(ctx: SigningContext, error: unknown) {
  ctx.log?.warn('kms_sign_failed', {
    address: ctx.address,
    keyArn: ctx.keyArn,
    errorName: errorName(error),
    errorMessage: error instanceof Error ? error.message : 'unknown',
  });
  return walletError(error);
}

function signerFor(ctx: SigningContext, networkPassphrase: string): KmsStellarSigner {
  const { address, keyArn } = ctx;
  return {
    address,
    keyArn,
    signTransaction: async (envelope, opts) => {
      try {
        const tx = TransactionBuilder.fromXDR(
          envelope,
          opts?.networkPassphrase || networkPassphrase,
        );
        tx.addSignature(address, (await signPayload(ctx, tx.hash())).toString('base64'));
        return { signedTxXdr: tx.toXDR(), signerAddress: address };
      } catch (error) {
        return { signedTxXdr: '', signerAddress: address, error: failed(ctx, error) };
      }
    },
    signAuthEntry: async (preimage) => {
      try {
        const signature = await signPayload(ctx, hash(Buffer.from(preimage, 'base64')));
        return { signedAuthEntry: signature.toString('base64'), signerAddress: address };
      } catch (error) {
        return { signedAuthEntry: '', signerAddress: address, error: failed(ctx, error) };
      }
    },
  };
}

/**
 * Failure model: `KmsKeyRejectedError` means the key is wrong (a security event); any other error
 * from this function is a KMS operational failure (NotFound, AccessDenied, throttling, ...).
 *
 * Resolves the role's alias (`kmsAliasFor`), proves the key derives to that address, and returns a signer
 * that signs by key ARN, so a later alias change cannot redirect a loaded signer.
 */
export async function loadKmsSigner(
  client: KmsSigningClient,
  expected: KmsKeyRef,
  networkPassphrase: string,
  log?: Logger,
): Promise<KmsStellarSigner> {
  const { keyArn } = await checkedKey(client, expected);
  return signerFor({ client, address: expected.address, keyArn, log }, networkPassphrase);
}
