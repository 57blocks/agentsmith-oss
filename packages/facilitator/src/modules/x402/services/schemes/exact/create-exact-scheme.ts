import type { Clock } from '../../../../channels/core/channel-pool.js';
import type { SchemeOptions, SignerSetup } from '../signers.js';
import { ExactChannelScheme } from './exact-channel-scheme.js';

/**
 * The standard x402 `exact` scheme. Verification, simulation, signing and submission are the
 * upstream `@x402/stellar` implementation; this repository only supplies the leased channel and
 * the fee payer, and advertises neither.
 */
export function createExactScheme(
  signers: SignerSetup,
  options: SchemeOptions & { clock?: Clock },
): ExactChannelScheme {
  return new ExactChannelScheme({ ...options, feeBumpSigner: signers.feeBumpSigner });
}
