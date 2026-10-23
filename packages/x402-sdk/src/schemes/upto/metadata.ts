import { StrKey } from '@stellar/stellar-sdk';
import type { SupportedKind } from '@x402/core/types';

/**
 * Validates and narrows the Facilitator's upto contract, authorization address and sponsorship.
 * The authorization address comes from scheme metadata, not the advertised fee-payer list.
 * It must be a G-account because the current Buyer flow also uses it as transaction source.
 * @throws TypeError when a required field is absent, malformed or has the wrong type.
 */
export function assertUptoMetadata(
  supported: Pick<SupportedKind, 'extra'>,
): asserts supported is Pick<SupportedKind, 'extra'> & {
  extra: { settlementContract: string; facilitator: string; areFeesSponsored: boolean };
} {
  const { settlementContract, facilitator, areFeesSponsored } = supported.extra ?? {};
  if (
    typeof settlementContract !== 'string' ||
    !StrKey.isValidContract(settlementContract) ||
    typeof facilitator !== 'string' ||
    !StrKey.isValidEd25519PublicKey(facilitator) ||
    typeof areFeesSponsored !== 'boolean'
  ) {
    throw new TypeError(
      'Facilitator must advertise valid upto Kernel, authorization address and fee sponsorship',
    );
  }
}
