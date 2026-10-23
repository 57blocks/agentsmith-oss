export { createBuyerFetch, type BuyerFetchConfig } from './buyer/buyer-fetch.js';
export { UptoStellarClient } from './schemes/upto/client.js';
export { x402HTTPClient } from '@x402/core/client';
export type {
  PaymentRequired,
  PaymentRequirements,
  PaymentPayload,
  SettleResponse,
} from '@x402/core/types';
export type { ClientStellarSigner, RpcConfig } from '@x402/stellar';

/**
 * Creates the upstream Node Ed25519 signer with address, signAuthEntry and signTransaction.
 * The application supplies its Stellar secret seed and owns key storage. Signing happens locally;
 * signAuthEntry signs the authorization preimage passed by the scheme's Stellar SDK lifecycle.
 * No test observers or manual auth-entry construction are required.
 *
 * @example
 * ```ts
 * const signer = createEd25519Signer(secret, 'stellar:testnet');
 * const signed = await signer.signAuthEntry(authPreimage);
 * ```
 * @param privateKey Stellar secret seed; passed directly to the upstream signer factory.
 * @param defaultNetwork Network for signing; upstream defaults to stellar:testnet. Match the client.
 * @returns The native Ed25519 signer; creation does not submit requests or payments.
 * @throws Error when the upstream factory rejects the key or network.
 */
export { createEd25519Signer } from '@x402/stellar';
