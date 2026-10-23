import type { FacilitatorConfig } from '../../../../../config/facilitator.config.js';
import type { Logger } from '../../../../../common/logger.js';
import type { SchemeOptions, SignerSetup } from '../signers.js';
import { UptoStellarScheme } from './upto-stellar.scheme.js';

/**
 * The experimental Kernel-backed `upto` scheme, implemented in this folder because upstream x402
 * has no Stellar `upto` yet. Undefined when no Kernel contract is configured.
 */
export function createUptoScheme(
  config: FacilitatorConfig,
  signers: SignerSetup,
  options: SchemeOptions & { log?: Logger },
): UptoStellarScheme | undefined {
  if (!config.uptoKernelContract) return undefined;
  if (!signers.authorizationSigner) {
    throw new Error('upto requires a stable authorization signer');
  }
  return new UptoStellarScheme(config.uptoKernelContract, {
    ...options,
    authorizationSigner: signers.authorizationSigner,
    feeBumpSigner: signers.feeBumpSigner,
  });
}
