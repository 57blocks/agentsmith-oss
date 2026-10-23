import type { PaymentRequirements, SchemeNetworkServer, SupportedKind } from '@x402/core/types';
import { ExactStellarScheme } from '@x402/stellar/exact/server';
import { assertUptoMetadata } from './metadata.js';

/** Our experimental Stellar upto resource-server scheme, prepared for upstream contribution. */
export class UptoStellarServer implements SchemeNetworkServer {
  readonly scheme = 'upto';
  readonly defaultAssetTransferMethod = 'default';
  readonly paymentFlows = {
    default: { supported: ['authorization'] as const, default: 'authorization' as const },
  };
  readonly #pricing = new ExactStellarScheme();

  /**
   * Converts a price to an atomic token amount using upstream Stellar pricing.
   * Explicit asset/amount values retain their atomic amount; money values use upstream defaults.
   * For arbitrary SEP-41 tokens, supply an explicit asset and an already converted atomic amount.
   * @throws Error when upstream pricing cannot resolve the asset, amount or network.
   */
  parsePrice = this.#pricing.parsePrice.bind(this.#pricing);
  /**
   * Returns decimals for an asset address or symbol in the upstream network defaults.
   * Returns undefined for unknown assets; does not query the token contract or assume a precision.
   */
  getAssetDecimals = this.#pricing.getAssetDecimals.bind(this.#pricing);

  /**
   * Adds Kernel contract, authorization address and fee sponsorship from Facilitator metadata.
   * Called by native x402 after matching the scheme/network; extension keys are unused here.
   * @returns New requirements preserving caller extras alongside the advertised upto terms.
   * @throws TypeError for invalid metadata or caller extras conflicting with advertised terms.
   */
  async enhancePaymentRequirements(
    requirements: PaymentRequirements,
    supported: SupportedKind,
    _extensions: string[],
  ): Promise<PaymentRequirements> {
    assertUptoMetadata(supported);
    const { settlementContract, facilitator, areFeesSponsored } = supported.extra;
    const terms = { settlementContract, facilitator, areFeesSponsored };
    for (const [field, value] of Object.entries(terms)) {
      const override = requirements.extra?.[field];
      if (override !== undefined && override !== value) {
        throw new TypeError('upto terms conflict with Facilitator capability metadata');
      }
    }
    return { ...requirements, extra: { ...requirements.extra, ...terms } };
  }
}
