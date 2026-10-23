import { createEd25519Signer } from '@x402/stellar';
import { wrapFetchWithPayment } from '@x402/fetch';
import { createPaymentClient } from './payment-client.js';
import type { Network, PaymentRequirements } from '@x402/core/types';
import type { RpcConfig } from '@x402/stellar';
import { x402HTTPClient } from '@x402/core/client';
import type {
  AfterPaymentCreationHook,
  BeforePaymentCreationHook,
  OnPaymentCreationFailureHook,
  OnPaymentResponseHook,
  PaymentRequiredHook,
} from '@x402/core/client';

/** Network, local signing key and optional Stellar payment configuration for a Node Buyer. */
export interface BuyerFetchConfig {
  /** Stellar network to use for signing and payment: stellar:testnet or stellar:pubnet. */
  network: Network;
  /** Stellar RPC settings; pubnet requires a URL, while testnet has an upstream default. */
  rpcConfig?: RpcConfig;
  /** Built-in schemes to enable; defaults to both exact and upto. */
  schemes?: readonly PaymentRequirements['scheme'][];
  /** Stellar secret seed from application-owned key storage; used by the native local signer. */
  secret: string;
  /**
   * Native hook awaited after quote selection and before payment creation/simulation/signing.
   * Resolve without a value to approve, or return { abort: true, reason } to stop payment.
   * The application displays the quote; omission enables automatic signing without confirmation.
   */
  onBeforePaymentCreation?: BeforePaymentCreationHook;
  /** Awaited after payload creation and before paid transport; does not establish settlement. */
  onAfterPaymentCreation?: AfterPaymentCreationHook;
  /**
   * Native creation/signing failure hook; can recover with { recovered: true, payload }.
   * Does not catch approval rejection, HTTP hook failure or resource-request transport errors.
   */
  onPaymentCreationFailure?: OnPaymentCreationFailureHook;
  /**
   * Observes a paid HTTP response and any native receipt; a missing receipt remains absent.
   * Returning { recovered: true } asks upstream to create a fresh payment and resend the request.
   */
  onPaymentResponse?: OnPaymentResponseHook;
  /**
   * Awaited on an initial 402 before payment selection; optional returned headers trigger a retry.
   * If that retry returns a non-402 response, upstream returns it without creating payment.
   */
  onPaymentRequired?: PaymentRequiredHook;
}

/**
 * Creates a ready-to-call Node paid fetch from a Stellar secret seed and network.
 * Builds the native Ed25519 signer, registers exact/upto (both by default), and binds the official
 * x402 fetch wrapper. Optional rpcConfig sets the Stellar RPC connection; schemes selects exact/upto.
 * Upto signs only against the SDK-pinned Kernel for the network; a Facilitator advertising any other
 * settlement contract is refused. The pinned Kernel is not a caller input and cannot be overridden.
 * Setup performs no network calls or signing. Supports tokens implementing the SEP-41 interface.
 *
 * Signing, request replay, redirects, errors and recovery follow the upstream schemes and wrapper.
 * The application owns key storage; this function does not load environment variables or persist
 * the seed. RPC simulation and authorization signing happen when a request requires payment.
 * An optional onBeforePaymentCreation hook can show the selected quote and await user approval;
 * abort or rejection prevents signing and paid resend. Without it, payments are signed automatically.
 * The SDK does not render a dialog. Exact amount is fixed; upto amount is the authorization ceiling.
 * All five hooks use native contracts. HTTP hooks may retry with supplied headers; creation-failure
 * hooks may supply a recovered payload; response recovery may create a fresh payment and resend.
 * After-creation is not settlement confirmation; response hooks receive a receipt only if present.
 *
 * @see https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0041.md
 *
 * @example
 * ```ts
 * const paidFetch = createBuyerFetch({
 *   secret,
 *   network: 'stellar:testnet',
 *   onBeforePaymentCreation: async ({ selectedRequirements }) => {
 *     const approved = await showPaymentConfirmation(selectedRequirements);
 *     if (!approved) return { abort: true, reason: 'User rejected payment' };
 *   },
 * });
 * const response = await paidFetch(url, { signal: AbortSignal.timeout(90000) });
 * const resource = await response.json();
 * ```
 * @returns Official x402 paid fetch, bound to the current global fetch and configured native client.
 * @throws Error when the native signer rejects the secret or network.
 * @throws TypeError for invalid client configuration, including unsupported schemes.
 */
export function createBuyerFetch(
  config: BuyerFetchConfig,
): ReturnType<typeof wrapFetchWithPayment> {
  const {
    secret,
    onBeforePaymentCreation,
    onAfterPaymentCreation,
    onPaymentCreationFailure,
    onPaymentResponse,
    onPaymentRequired,
    ...clientConfig
  } = config;
  const signer = createEd25519Signer(secret, clientConfig.network);
  const client = createPaymentClient({ ...clientConfig, signer });
  if (onBeforePaymentCreation) client.onBeforePaymentCreation(onBeforePaymentCreation);
  if (onAfterPaymentCreation) client.onAfterPaymentCreation(onAfterPaymentCreation);
  if (onPaymentCreationFailure) client.onPaymentCreationFailure(onPaymentCreationFailure);
  if (onPaymentResponse) client.onPaymentResponse(onPaymentResponse);
  const http = new x402HTTPClient(client);
  if (onPaymentRequired) http.onPaymentRequired(onPaymentRequired);
  return wrapFetchWithPayment(globalThis.fetch.bind(globalThis), http);
}
