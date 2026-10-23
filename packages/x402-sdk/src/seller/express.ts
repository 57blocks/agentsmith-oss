import { SETTLEMENT_OVERRIDES_HEADER, x402HTTPResourceServer } from '@x402/core/server';
import type { PaywallConfig, PaywallProvider, RouteConfig, RoutesConfig } from '@x402/core/server';
import { paymentMiddlewareFromHTTPServer, setSettlementOverrides } from '@x402/express';
import type { RequestHandler } from 'express';
import type { BeforeSettleHook, HTTPTransportContext } from '@x402/core/server';
import { isNonNegativeI128 } from '../schemes/amount.js';

export { setSettlementOverrides };
import { createResourceServer } from './resource-server.js';
import type { ResourceServerConfig } from './resource-server.js';

type RoutePaymentOption = Omit<Exclude<RouteConfig['accepts'], unknown[]>, 'network'>;

/** Native x402 route settings whose payment options inherit the middleware network. */
export type PaymentRouteConfig = Omit<RouteConfig, 'accepts'> & {
  accepts: RoutePaymentOption | RoutePaymentOption[];
};

/** Seller route and optional browser paywall settings for native Express middleware. */
export interface PaymentMiddlewareConfig extends Pick<
  ResourceServerConfig,
  'network' | 'facilitator'
> {
  /** Paid routes keyed by native x402 patterns, such as GET /weather. */
  routes: Record<string, PaymentRouteConfig>;
  /** Browser payment-page settings passed unchanged to x402; omitted uses upstream defaults. */
  paywallConfig?: PaywallConfig;
  /** Optional HTML payment-page provider; omitted uses the upstream page generator. */
  paywall?: PaywallProvider;
}

/**
 * Creates native payment middleware for Express or Nest using the Express adapter.
 * Applies one network to every payment option, infers exact/upto registrations from routes,
 * and discovers Facilitator capabilities before returning. The caller mounts the middleware
 * before paid handlers; native x402 handles payment challenges, verification and settlement.
 *
 * @example
 * ```ts
 * import express from 'express';
 * import { createPaymentMiddleware } from 'agentsmith-x402-sdk/seller/express';
 *
 * const asset = process.env.TOKEN_CONTRACT;
 * const payTo = process.env.SELLER_ADDRESS;
 * if (!asset || !payTo) throw new Error('Set TOKEN_CONTRACT and SELLER_ADDRESS');
 *
 * const app = express();
 * app.use(await createPaymentMiddleware({
 *   network: 'stellar:testnet',
 *   facilitator: { url: 'https://agentsmith.xyz/facilitator' },
 *   routes: {
 *     'GET /weather': {
 *       accepts: { scheme: 'exact', payTo, price: { asset, amount: '40000' } },
 *     },
 *   },
 * }));
 * app.get('/weather', (_req, res) => res.json({ forecast: 'sunny' }));
 * app.listen(3000);
 * ```
 * Set the token contract and seller address for testnet; amount is in atomic token units.
 * Upto handlers must call setSettlementOverrides(res, { amount }) with positive atomic actual
 * usage no greater than the signed maximum; missing or invalid usage prevents settlement.
 * Unpaid requests receive 402; x402 verifies paid requests and settles successful responses.
 *
 * @returns Middleware to mount with app.use(); does not create an application or handlers.
 * @throws TypeError for invalid configuration, empty payment routes or unsupported capabilities.
 * @throws ResourceServerInitializationError when Facilitator capability discovery fails.
 * @throws RouteConfigurationError when native x402 rejects a route's payment flow.
 */
export async function createPaymentMiddleware(
  config: PaymentMiddlewareConfig,
): Promise<RequestHandler> {
  const { routes, schemes } = preparePaymentRoutes(config.routes, config.network);
  const server = await createResourceServer({
    network: config.network,
    facilitator: config.facilitator,
    schemes,
  });
  server.onBeforeSettle(requireActualUsage);
  const httpServer = new x402HTTPResourceServer(server, routes);
  // Core discovery is complete; HTTP construction validates the routes' native payment flows.
  return paymentMiddlewareFromHTTPServer(httpServer, config.paywallConfig, config.paywall, false);
}

function preparePaymentRoutes(
  input: PaymentMiddlewareConfig['routes'],
  network: ResourceServerConfig['network'],
): { routes: RoutesConfig; schemes: RoutePaymentOption['scheme'][] } {
  const routes: Record<string, RouteConfig> = {};
  const schemes = new Set<RoutePaymentOption['scheme']>();
  for (const [pattern, route] of Object.entries(input)) {
    const options = Array.isArray(route.accepts) ? route.accepts : [route.accepts];
    if (options.length === 0)
      throw new TypeError('A paid route must declare at least one payment option');
    routes[pattern] = {
      ...route,
      accepts: options.map((option) => {
        schemes.add(option.scheme);
        return { ...option, network };
      }),
    };
  }
  if (schemes.size === 0) throw new TypeError('Configure at least one paid route');
  return { routes, schemes: [...schemes] };
}

// Only the Seller response may declare usage; request headers cannot authorize a charge.
const requireActualUsage: BeforeSettleHook = async (context) => {
  if (context.paymentPayload.accepted.scheme !== 'upto') return;
  const transport = context.transportContext as HTTPTransportContext | undefined;
  const header = Object.entries(transport?.responseHeaders ?? {}).find(
    ([name]) => name.toLowerCase() === SETTLEMENT_OVERRIDES_HEADER.toLowerCase(),
  )?.[1];
  if (!header) return { abort: true, reason: 'upto_actual_amount_required' };
  let amount: unknown;
  try {
    const override: unknown = JSON.parse(header);
    if (override && typeof override === 'object' && 'amount' in override) amount = override.amount;
  } catch {
    return { abort: true, reason: 'invalid_upto_actual_amount' };
  }
  if (
    typeof amount !== 'string' ||
    !isNonNegativeI128(amount) ||
    BigInt(amount) > BigInt(context.paymentPayload.accepted.amount)
  ) {
    return { abort: true, reason: 'invalid_upto_actual_amount' };
  }
};
