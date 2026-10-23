import type * as NativeExpress from '@x402/express';
import { createRequire } from 'node:module';
import express from 'express';
import request from 'supertest';
import { StrKey } from '@stellar/stellar-sdk';
import {
  HTTPFacilitatorClient,
  RouteConfigurationError,
  x402HTTPResourceServer,
} from '@x402/core/server';
import type { PaywallProvider } from '@x402/core/server';
import type { SupportedResponse } from '@x402/core/types';
import {
  decodePaymentResponseHeader,
  encodePaymentSignatureHeader,
  decodePaymentRequiredHeader,
} from '@x402/core/http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createResourceServer } from '../../src/seller/resource-server.js';
import { createPaymentMiddleware, setSettlementOverrides } from '../../src/seller/express.js';
import type { PaymentMiddlewareConfig } from '../../src/seller/express.js';

const require = createRequire(import.meta.url);
const cjsExpress = require('@x402/express') as Pick<
  typeof NativeExpress,
  'paymentMiddlewareFromHTTPServer'
>;

const asset = StrKey.encodeContract(Buffer.alloc(32, 10));
const payTo = StrKey.encodeEd25519PublicKey(Buffer.alloc(32, 11));
const amount = '900719925474099312345';
const exact = { scheme: 'exact', payTo, price: { asset, amount } };
const uptoMetadata = {
  settlementContract: StrKey.encodeContract(Buffer.alloc(32, 12)),
  facilitator: StrKey.encodeEd25519PublicKey(Buffer.alloc(32, 13)),
  areFeesSponsored: true,
};
const supported: SupportedResponse = {
  kinds: [
    {
      x402Version: 2,
      scheme: 'exact',
      network: 'stellar:testnet',
      extra: { areFeesSponsored: true },
    },
    { x402Version: 2, scheme: 'upto', network: 'stellar:testnet', extra: uptoMetadata },
  ],
  extensions: [],
  signers: {},
};
const config = {
  network: 'stellar:testnet' as const,
  facilitator: { url: 'https://facilitator.example.com' },
};

function fixture(response = supported) {
  const discover = vi
    .spyOn(HTTPFacilitatorClient.prototype, 'getSupported')
    .mockResolvedValue(response);
  const verify = vi
    .spyOn(HTTPFacilitatorClient.prototype, 'verify')
    .mockResolvedValue({ isValid: true });
  const settle = vi
    .spyOn(HTTPFacilitatorClient.prototype, 'settle')
    .mockResolvedValue({ success: true, network: config.network, transaction: 'a'.repeat(64) });
  return { discover, verify, settle };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('Express convenience configuration', () => {
  it('inherits one network and preserves the atomic price and route metadata', async () => {
    const { discover, verify, settle } = fixture();
    const routes = {
      'GET /weather': { accepts: exact, mimeType: 'application/json', description: 'Forecast' },
    };
    const original = structuredClone(routes);
    const middleware = await createPaymentMiddleware({ ...config, routes });
    const app = express();
    app.use(middleware);
    const response = await request(app).get('/weather').set('Accept', 'application/json');
    expect(response.status).toBe(402);
    const challenge = decodePaymentRequiredHeader(String(response.headers['payment-required']));
    expect(challenge.accepts).toHaveLength(1);
    expect(challenge.accepts[0]).toMatchObject({
      scheme: 'exact',
      network: config.network,
      asset,
      amount,
      payTo,
    });
    expect(challenge.resource?.description).toBe('Forecast');
    expect(routes).toEqual(original);
    expect(discover).toHaveBeenCalledOnce();
    expect(verify).not.toHaveBeenCalled();
    expect(settle).not.toHaveBeenCalled();
  });
  it('renders a browser payment challenge with the supplied paywall and config', async () => {
    const { discover, verify, settle } = fixture();
    const paywallConfig = { appName: 'Weather Seller', testnet: true };
    const generateHtml = vi.fn<PaywallProvider['generateHtml']>(
      (_paymentRequired, config) => `<html><body>${config?.appName}</body></html>`,
    );
    const options = {
      ...config,
      routes: { 'GET /weather': { accepts: exact } },
      paywallConfig,
      paywall: { generateHtml },
    };
    const app = express();
    app.use(await createPaymentMiddleware(options));
    const response = await request(app)
      .get('/weather')
      .set('Accept', 'text/html')
      .set('User-Agent', 'Mozilla/5.0');
    expect(response.status).toBe(402);
    expect(response.headers['content-type']).toContain('text/html');
    expect(response.text).toBe('<html><body>Weather Seller</body></html>');
    expect(generateHtml).toHaveBeenCalledOnce();
    expect(generateHtml).toHaveBeenCalledWith(
      expect.objectContaining({ accepts: [expect.objectContaining({ scheme: 'exact' })] }),
      paywallConfig,
    );
    expect(discover).toHaveBeenCalledOnce();
    expect(verify).not.toHaveBeenCalled();
    expect(settle).not.toHaveBeenCalled();
  });
  it('infers both scheme registrations from the advertised route options', async () => {
    fixture();
    const app = express();
    app.use(
      await createPaymentMiddleware({
        ...config,
        routes: {
          'GET /weather': { accepts: [exact, { ...exact, scheme: 'upto' }] },
        },
      }),
    );
    const response = await request(app).get('/weather').set('Accept', 'application/json');
    expect(response.status).toBe(402);
    const challenge = decodePaymentRequiredHeader(String(response.headers['payment-required']));
    expect(challenge.accepts.map((option) => option.scheme)).toEqual(['exact', 'upto']);
    expect(challenge.accepts[1]?.extra).toMatchObject(uptoMetadata);
  });
  it('enables upto without requiring exact capability', async () => {
    fixture({ ...supported, kinds: [supported.kinds[1]!] });
    const app = express();
    app.use(
      await createPaymentMiddleware({
        ...config,
        routes: {
          'GET /weather': { accepts: { ...exact, scheme: 'upto' } },
        },
      }),
    );
    const response = await request(app).get('/weather').set('Accept', 'application/json');
    expect(response.status).toBe(402);
    expect(
      decodePaymentRequiredHeader(String(response.headers['payment-required'])).accepts[0]?.scheme,
    ).toBe('upto');
  });
  it('preserves the upstream request-context dynamic price callback', async () => {
    fixture();
    const app = express();
    app.use(
      await createPaymentMiddleware({
        ...config,
        routes: {
          'GET /weather': {
            accepts: {
              ...exact,
              price: (context) => ({
                asset,
                amount: context.adapter.getQueryParam?.('period') === 'week' ? '70000' : '10000',
              }),
            },
          },
        },
      }),
    );
    const response = await request(app)
      .get('/weather?period=week')
      .set('Accept', 'application/json');
    expect(
      decodePaymentRequiredHeader(String(response.headers['payment-required'])).accepts[0]?.amount,
    ).toBe('70000');
  });
  const invalidRoutes: { reason: string; routes: PaymentMiddlewareConfig['routes'] }[] = [
    { reason: 'an empty route map', routes: {} },
    { reason: 'an empty accepts list', routes: { 'GET /weather': { accepts: [] } } },
  ];
  it.each(invalidRoutes)('rejects $reason before capability discovery', async ({ routes }) => {
    const { discover } = fixture();
    await expect(createPaymentMiddleware({ ...config, routes })).rejects.toThrow(TypeError);
    expect(discover).not.toHaveBeenCalled();
  });
  it('rejects an unsupported scheme before capability discovery', async () => {
    const { discover } = fixture();
    await expect(
      createPaymentMiddleware({
        ...config,
        routes: { 'GET /weather': { accepts: { ...exact, scheme: 'escrow' } } },
      }),
    ).rejects.toThrow(TypeError);
    expect(discover).not.toHaveBeenCalled();
  });
  it('rejects missing facilitator support before returning middleware', async () => {
    fixture({ ...supported, kinds: [supported.kinds[0]!] });
    await expect(
      createPaymentMiddleware({
        ...config,
        routes: { 'GET /weather': { accepts: { ...exact, scheme: 'upto' } } },
      }),
    ).rejects.toThrow(/does not support/);
  });
  it('uses native startup validation for an unsupported payment flow', async () => {
    fixture();
    await expect(
      createPaymentMiddleware({
        ...config,
        routes: { 'GET /weather': { accepts: { ...exact, extra: { paymentFlow: 'invalid' } } } },
      }),
    ).rejects.toThrow(RouteConfigurationError);
  });
});

describe('upto actual usage', () => {
  it.each([
    { usage: undefined, expected: 402 },
    { usage: '0', expected: 200 },
    { usage: '-1', expected: 402 },
    { usage: '1.5', expected: 402 },
    { usage: '900719925474099312346', expected: 402 },
    { usage: '00', expected: 402 },
    { usage: '20000', expected: 200 },
    { usage: amount, expected: 200 },
  ])('settles only explicit valid atomic usage: $usage', async ({ usage, expected }) => {
    const { settle } = fixture();
    const app = express();
    app.use(
      await createPaymentMiddleware({
        ...config,
        routes: { 'GET /weather': { accepts: { ...exact, scheme: 'upto' } } },
      }),
    );
    app.get('/weather', (_req, res) => {
      if (usage !== undefined) setSettlementOverrides(res, { amount: usage });
      res.json({ forecast: 'sunny' });
    });
    const unpaid = await request(app)
      .get('/weather')
      .set('Accept', 'application/json')
      .expect((response) => {
        expect(
          response.status,
          JSON.stringify({ body: response.body, headers: response.headers }),
        ).toBe(402);
      });
    const quote = decodePaymentRequiredHeader(String(unpaid.headers['payment-required']));
    const payment = {
      x402Version: 2,
      accepted: quote.accepts[0]!,
      payload: { transaction: 'test' },
    };
    const paid = await request(app)
      .get('/weather')
      .set('Accept', 'application/json')
      .set('PAYMENT-SIGNATURE', encodePaymentSignatureHeader(payment));
    expect(paid.status).toBe(expected);
    if (expected === 200) {
      expect(settle).toHaveBeenCalledOnce();
      expect(settle.mock.calls[0]?.[0]).toEqual(payment);
      expect(settle.mock.calls[0]?.[1]).toEqual({ ...payment.accepted, amount: usage });
      expect(paid.body).toEqual({ forecast: 'sunny' });
    } else {
      expect(settle).not.toHaveBeenCalled();
      if (usage === undefined) {
        expect(
          decodePaymentResponseHeader(String(paid.headers['payment-response'])).errorReason,
        ).toBe('upto_actual_amount_required');
      }
    }
  });
});

describe('Facilitator transport errors', () => {
  it.each(
    (['verify', 'settle'] as const).flatMap((operation) =>
      [200, 401, 500].map((status) => ({ operation, status })),
    ),
  )(
    'hides malformed $operation responses with HTTP $status before native HTTP rendering',
    async ({ operation, status }) => {
      fixture();
      vi.mocked(HTTPFacilitatorClient.prototype[operation]).mockRestore();
      const marker = 'SYNTHETIC_PRIVATE_RESPONSE';
      vi.stubGlobal(
        'fetch',
        vi.fn<typeof fetch>().mockResolvedValue(Response.json({ unexpected: marker }, { status })),
      );
      const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
      const warnLog = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const app = express();
      app.use(
        await createPaymentMiddleware({
          ...config,
          routes: { 'GET /weather': { accepts: exact } },
        }),
      );
      app.get('/weather', (_req, res) => res.json({ forecast: 'sunny' }));
      const unpaid = await request(app)
        .get('/weather')
        .set('Accept', 'application/json')
        .expect((response) => {
          expect(
            response.status,
            JSON.stringify({ body: response.body, headers: response.headers }),
          ).toBe(402);
        });
      const quote = decodePaymentRequiredHeader(String(unpaid.headers['payment-required']));
      const paid = await request(app)
        .get('/weather')
        .set('Accept', 'application/json')
        .set(
          'PAYMENT-SIGNATURE',
          encodePaymentSignatureHeader({
            x402Version: 2,
            accepted: quote.accepts[0]!,
            payload: { transaction: 'test' },
          }),
        );
      expect(paid.status).toBe(502);
      expect(paid.body).toEqual({ error: `Facilitator ${operation} request failed` });
      for (const name of ['payment-required', 'payment-response']) {
        expect(Buffer.from(String(paid.headers[name] ?? ''), 'base64').toString()).not.toContain(
          marker,
        );
      }
      expect(JSON.stringify(errorLog.mock.calls)).not.toContain(marker);
      expect(JSON.stringify(warnLog.mock.calls)).not.toContain(marker);
    },
  );
});

describe('native buffering with an explicit response status', () => {
  it.each(
    (['exact', 'upto'] as const).flatMap((scheme) =>
      [200, 201, 400, 500].flatMap((status) =>
        [false, true].flatMap((reasonPhrase) =>
          ['SDK ESM', 'native CJS'].map((adapter) => ({ scheme, status, reasonPhrase, adapter })),
        ),
      ),
    ),
  )(
    '$adapter honors $scheme res.status($status) before writeHead, reason phrase: $reasonPhrase',
    async ({ scheme, status, reasonPhrase, adapter }) => {
      const { settle } = fixture();
      const observed: { status: number; headersSent: boolean }[] = [];
      const app = express();
      if (adapter === 'SDK ESM') {
        app.use(
          await createPaymentMiddleware({
            ...config,
            routes: { 'GET /weather': { accepts: { ...exact, scheme } } },
          }),
        );
      } else {
        const server = await createResourceServer({ ...config, schemes: [scheme] });
        const httpServer = new x402HTTPResourceServer(server, {
          'GET /weather': { accepts: { ...exact, scheme, network: config.network } },
        });
        app.use(
          cjsExpress.paymentMiddlewareFromHTTPServer(httpServer, undefined, undefined, false),
        );
      }
      app.get('/weather', (_req, res) => {
        if (scheme === 'upto') setSettlementOverrides(res, { amount: '20000' });
        // Native x402 decides settlement using statusCode before replaying buffered writes.
        if (status < 400) res.status(500);
        res.status(status);
        if (reasonPhrase) res.writeHead(status, 'Forecast status', { 'X-Result': 'forecast' });
        else res.writeHead(status, { 'X-Result': 'forecast' });
        observed.push({ status: res.statusCode, headersSent: res.headersSent });
        res.end(status >= 400 ? 'unavailable' : 'sunny');
      });
      const unpaid = await request(app)
        .get('/weather')
        .set('Accept', 'application/json')
        .expect((response) => {
          expect(
            response.status,
            JSON.stringify({ body: response.body, headers: response.headers }),
          ).toBe(402);
        });
      const quote = decodePaymentRequiredHeader(String(unpaid.headers['payment-required']));
      const payment = {
        x402Version: 2,
        accepted: quote.accepts[0]!,
        payload: { transaction: 'test' },
      };
      const paid = await request(app)
        .get('/weather')
        .set('Accept', 'application/json')
        .set('PAYMENT-SIGNATURE', encodePaymentSignatureHeader(payment));
      expect(observed).toEqual([{ status, headersSent: false }]);
      expect(paid.status).toBe(status);
      expect(paid.headers['x-result']).toBe('forecast');
      expect(paid.text).toBe(status >= 400 ? 'unavailable' : 'sunny');
      if (status >= 400) {
        expect(settle).not.toHaveBeenCalled();
        expect(paid.headers['payment-response']).toBeUndefined();
      } else {
        expect(settle).toHaveBeenCalledOnce();
        expect(settle.mock.calls[0]?.[0]).toEqual(payment);
        expect(settle.mock.calls[0]?.[1]).toEqual({
          ...payment.accepted,
          amount: scheme === 'upto' ? '20000' : amount,
        });
        expect(decodePaymentResponseHeader(String(paid.headers['payment-response']))).toEqual({
          success: true,
          network: config.network,
          transaction: 'a'.repeat(64),
        });
      }
    },
  );
});
