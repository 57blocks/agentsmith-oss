import type { Network, PaymentRequirements, SettleResponse } from '@x402/core/types';

/** Whether the settle charges nothing, so no transaction is sent. */
export function isZeroSettlement(requirements: PaymentRequirements): boolean {
  return requirements.amount === '0';
}

/**
 * The answer to a verified settlement of zero, as upstream EVM `upto` gives it: settled, with no
 * transaction hash because nothing is sent.
 */
export function zeroSettlement(network: Network, payer: string | undefined): SettleResponse {
  return { success: true, network, transaction: '', amount: '0', payer };
}
