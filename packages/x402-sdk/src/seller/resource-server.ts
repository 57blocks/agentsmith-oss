import { SafeHTTPFacilitatorClient, safeFacilitatorFailure } from './facilitator-client.js';
import { x402ResourceServer } from '@x402/core/server';
import type { FacilitatorClient } from '@x402/core/server';
import type { Network, PaymentRequirements, SchemeNetworkServer } from '@x402/core/types';
import { ExactStellarScheme } from '@x402/stellar/exact/server';
import { STELLAR_PUBNET_CAIP2, STELLAR_TESTNET_CAIP2 } from '@x402/stellar';
import { UptoStellarServer } from '../schemes/upto/server.js';
import { assertUptoMetadata } from '../schemes/upto/metadata.js';
import {
  createAuthorizationHeaders,
  parseFacilitatorUrl,
  validateFacilitatorTimeout,
} from './facilitator-url.js';

/** Facilitator connection and built-in scheme selection for one Stellar network. */
export interface ResourceServerConfig {
  facilitator: {
    /** Facilitator base URL; must use HTTP(S) without credentials, query or fragment. */
    url: string;
    /** Required on pubnet; optional on testnet, where a given key is sent and checked. */
    apiKey?: string;
    /** Timeout per Facilitator request in milliseconds; defaults to 45,000. */
    timeoutMs?: number;
  };
  /** Stellar network to register: stellar:testnet or stellar:pubnet. */
  network: Network;
  /** Omission registers only exact. Pass ['upto'] or ['exact', 'upto'] to enable upto. */
  schemes?: readonly PaymentRequirements['scheme'][];
}

/** Safe setup error; excludes arbitrary upstream bodies and credentials. */
export class ResourceServerInitializationError extends Error {
  /**
   * Creates a setup error with an optional sanitized cause for capability discovery diagnostics.
   * Retains the operation, valid timeout and known network code; excludes raw upstream errors.
   * @param cause Initialization failure; arbitrary messages, bodies and nested causes are removed.
   */
  constructor(cause?: unknown) {
    super(
      'Unable to initialize the configured x402 resource server',
      cause === undefined ? undefined : { cause: safeFacilitatorFailure(cause, 'supported') },
    );
    this.name = 'ResourceServerInitializationError';
  }
}

/**
 * Creates and initializes a native x402 resource server for one Stellar network.
 * Fetches Facilitator capabilities before returning; omitting schemes registers only exact.
 * Pubnet requires an API key; testnet sends one only when given. Mount the result through native
 * x402 middleware, which owns verification and settlement during request handling.
 *
 * @returns An initialized server for framework integration and native hook registration.
 * @throws TypeError for invalid configuration or unsupported/malformed scheme capabilities.
 * @throws ResourceServerInitializationError when Facilitator capability discovery fails.
 */
export async function createResourceServer(
  config: ResourceServerConfig,
): Promise<x402ResourceServer> {
  if (config.network !== STELLAR_TESTNET_CAIP2 && config.network !== STELLAR_PUBNET_CAIP2) {
    throw new TypeError('Unsupported Stellar network');
  }
  const client = createFacilitatorClient(config.facilitator, config.network);
  const schemes = selectedAdapters(config);
  const server = new x402ResourceServer(client);
  for (const scheme of schemes) server.register(config.network, scheme);
  try {
    await server.initialize();
  } catch (error) {
    throw new ResourceServerInitializationError(error);
  }
  for (const scheme of schemes) {
    const supported = server.getSupportedKind(2, config.network, scheme.scheme);
    if (!supported)
      throw new TypeError('Facilitator does not support the configured network and schemes');
    if (scheme.scheme === 'upto') assertUptoMetadata(supported);
  }
  return server;
}

function selectedAdapters(config: ResourceServerConfig): SchemeNetworkServer[] {
  const names = config.schemes ?? ['exact'];
  if (
    names.length === 0 ||
    new Set(names).size !== names.length ||
    names.some((name) => name !== 'exact' && name !== 'upto')
  ) {
    throw new TypeError('Configure unique exact or upto scheme names');
  }
  return names.map((name) =>
    name === 'exact' ? new ExactStellarScheme() : new UptoStellarServer(),
  );
}

function createFacilitatorClient(
  config: ResourceServerConfig['facilitator'],
  network: Network,
): FacilitatorClient {
  const url = parseFacilitatorUrl(config.url);
  const timeoutMs = config.timeoutMs === undefined ? 45_000 : config.timeoutMs;
  validateFacilitatorTimeout(timeoutMs);
  // Pubnet requires a key; testnet stays anonymous unless one is given, which is then checked.
  const headers =
    network === STELLAR_PUBNET_CAIP2 || config.apiKey !== undefined
      ? createAuthorizationHeaders(config.apiKey)
      : {};
  return new SafeHTTPFacilitatorClient({
    url,
    timeoutMs,
    createAuthHeaders: async () => ({ supported: headers, verify: headers, settle: headers }),
  });
}
