import { GetPublicKeyCommand, KMSClient, SignCommand } from '@aws-sdk/client-kms';
import type { KmsSigningClient } from './kms-signer.js';

/** Counts the first attempt, so 3 means at most two retries. */
const MAX_ATTEMPTS = 3;
/**
 * The SDK's HTTP handler has no timeouts by default. These bound how long a stalled KMS call can
 * hold a channel; the failure then returns `{ error }` and the channel is released.
 * `throwOnRequestTimeout` is required, otherwise `requestTimeout` only logs a warning.
 */
const CONNECTION_TIMEOUT_MS = 3_000;
const REQUEST_TIMEOUT_MS = 5_000;
const SOCKET_TIMEOUT_MS = 5_000;

/** Credentials come from the SDK's default chain: the ECS task role when deployed. */
export function createAwsKmsClient(region: string): KmsSigningClient {
  const kms = new KMSClient({
    region,
    maxAttempts: MAX_ATTEMPTS,
    requestHandler: {
      connectionTimeout: CONNECTION_TIMEOUT_MS,
      requestTimeout: REQUEST_TIMEOUT_MS,
      socketTimeout: SOCKET_TIMEOUT_MS,
      throwOnRequestTimeout: true,
    },
  });
  return {
    async getPublicKey(keyId) {
      const out = await kms.send(new GetPublicKeyCommand({ KeyId: keyId }));
      if (!out.KeyId || !out.PublicKey) throw new Error(`KMS returned no public key for ${keyId}`);
      return {
        keyArn: out.KeyId,
        keySpec: out.KeySpec,
        keyUsage: out.KeyUsage,
        publicKey: out.PublicKey,
      };
    },
    async sign(keyArn, message) {
      const out = await kms.send(
        new SignCommand({
          KeyId: keyArn,
          Message: message,
          MessageType: 'RAW',
          SigningAlgorithm: 'ED25519_SHA_512',
        }),
      );
      if (!out.Signature) throw new Error(`KMS returned no signature for ${keyArn}`);
      return out.Signature;
    },
  };
}
