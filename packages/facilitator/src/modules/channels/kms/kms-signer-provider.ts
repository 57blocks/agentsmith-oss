import type { Logger } from '../../../common/logger.js';
import type { SignerLoad, SignerProvider } from '../core/stellar-signer.js';
import { KmsKeyRejectedError, loadKmsSigner, type KmsSigningClient } from './kms-signer.js';

/** The AWS SDK's error name for an alias, or key, that does not exist. */
const NOT_FOUND = 'NotFoundException';

/**
 * Channel signers held in KMS, looked up under `alias/x402/channel/<address>`. A key that does not
 * derive the address, and a missing alias, mean the account is wrong for this deployment. Every
 * other failure, `AccessDenied` included, is the key store's and is thrown: a permissions fault
 * belongs to the deployment, not to the account.
 */
export class KmsSignerProvider implements SignerProvider {
  readonly mode = 'kms';

  constructor(
    private readonly client: KmsSigningClient,
    private readonly networkPassphrase: string,
    private readonly log: Logger,
  ) {}

  async load(address: string): Promise<SignerLoad> {
    try {
      const signer = await loadKmsSigner(
        this.client,
        { role: 'channel', address },
        this.networkPassphrase,
        this.log,
      );
      // The address to key ARN audit trail; key material is never logged.
      this.log.info('kms_signer_loaded', { role: 'channel', address, keyArn: signer.keyArn });
      return { ok: true, signer };
    } catch (error) {
      if (error instanceof KmsKeyRejectedError) return { ok: false, reason: error.message };
      if (error instanceof Error && error.name === NOT_FOUND) {
        return { ok: false, reason: 'no KMS channel alias for this address' };
      }
      throw error;
    }
  }
}
