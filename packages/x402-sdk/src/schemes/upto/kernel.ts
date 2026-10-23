import type { Network } from '@x402/core/types';

/**
 * The upto settlement Kernel this SDK trusts, per network. The Buyer signs an authorization tree
 * rooted at this contract and refuses any Facilitator advertising a different one; it is the only
 * Kernel the SDK will sign for, so a redeploy to a new contract id requires an SDK release.
 *
 * The Kernel is a neutral, trustless primitive — no owner, upgrade, pause, withdrawal, or state —
 * that on-chain settles at most the Buyer's signed maximum, only to the signed recipient, and only
 * with both the Buyer's and the named Facilitator's authorization; no party, this SDK included, can
 * redirect funds or exceed the signed terms. It is nonetheless experimental and UNAUDITED, and
 * pinning it makes it the sole trust anchor for every upto Buyer. The scheme and client are
 * AgentSmith's own, intended for upstream contribution to x402, so this contract's ABI and these
 * addresses stay provisional until a standardized, versioned release lands.
 */
const PINNED_UPTO_KERNEL = {
  'stellar:testnet': 'CBB7WCIQOBOJ4G7JUPVOA3RI553HBSYQ3GLBJ25X7W7S7MRJIGVCXRE3',
  'stellar:pubnet': 'CCV4RALFBEE2QLKPK6H5ZX24CYMKIFN3723J5J4TMDEFWAFLELGYODNI',
} as const satisfies Partial<Record<Network, string>>;

/** The trusted Kernel contract address for a network, or undefined when upto is unavailable there. */
export function trustedUptoKernel(network: Network): string | undefined {
  return PINNED_UPTO_KERNEL[network as keyof typeof PINNED_UPTO_KERNEL];
}
