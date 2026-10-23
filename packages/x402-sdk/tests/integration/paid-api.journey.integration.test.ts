import express from 'express';
import { setSettlementOverrides } from '@x402/express';
import { loadEnvFile } from 'node:process';
import { existsSync } from 'node:fs';
import { Keypair, StrKey } from '@stellar/stellar-sdk';
import { getRpcClient, getUsdcAddress } from '@x402/stellar';
import type {
  PaymentPayload,
  PaymentRequired,
  PaymentRequirements,
  SettleResponse,
} from '@x402/core/types';
import {
  decodePaymentRequiredHeader,
  decodePaymentSignatureHeader,
  decodePaymentResponseHeader,
} from '@x402/core/http';
import { createBuyerFetch } from 'agentsmith-x402-sdk/buyer';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPaymentMiddleware } from 'agentsmith-x402-sdk/seller/express';
import type { PaymentMiddlewareConfig } from 'agentsmith-x402-sdk/seller/express';
import { closeLocalServers, listenLocally } from './support/local-server.js';
import { expectSignedPayment, readTokenBalance } from './support/payment-assertions.js';

const facilitatorUrl = 'https://testnet.agentsmith.xyz/facilitator';
const network = 'stellar:testnet';
const asset = getUsdcAddress(network);
const exactAmount = '40000';
const maxAmount = '40000';
const actualAmount = '20000';
// The Seller's Facilitator API key, read from the environment. Optional on testnet (the Facilitator
// accepts anonymous Sellers there); this journey still requires it to exercise the full authenticated case.
const apiKeyEnvVar = 'SELLER_API_KEY';

describe('Paid API journeys', () => {
  let sellerUrl: string;
  let payTo: string;
  let businessExecutions = 0;
  const receivedPayments: PaymentPayload[] = [];
  const confirmedRequirements: PaymentRequirements[] = [];
  const createdPayments: PaymentPayload[] = [];
  const receivedReceipts: SettleResponse[] = [];
  const creationFailures: string[] = [];
  const hookEvents: string[] = [];
  const receivedRequests: { path: string; paid: boolean }[] = [];
  let apiKey: string;

  beforeAll(async () => {
    if (existsSync('.env.integration')) loadEnvFile('.env.integration');
    const address = process.env.SELLER_ADDRESS?.trim() || process.env.X402_PAY_TO?.trim();
    if (!address) throw new Error('Set SELLER_ADDRESS or X402_PAY_TO for the integration Seller');
    payTo = address;

    // testnet does not require an API key — the Facilitator accepts anonymous Sellers there. This
    // journey supplies one anyway to exercise the complete authenticated case: once set, the key
    // authenticates every supported/verify/settle call the Seller makes below.
    apiKey = process.env[apiKeyEnvVar]?.trim() ?? '';
    if (!apiKey) throw new Error(`Set ${apiKeyEnvVar} for the integration Seller`);

    const routes: PaymentMiddlewareConfig['routes'] = {
      'GET /weather': {
        accepts: {
          scheme: 'exact',
          payTo,
          price: { asset, amount: exactAmount },
          maxTimeoutSeconds: 60,
        },
        mimeType: 'application/json',
      },
      'GET /weather-upto': {
        accepts: {
          scheme: 'upto',
          payTo,
          price: { asset, amount: maxAmount },
          maxTimeoutSeconds: 60,
        },
        mimeType: 'application/json',
      },
    };
    const app = express();
    app.use((req, _res, next) => {
      const payment = req.get('PAYMENT-SIGNATURE');
      receivedRequests.push({ path: req.path, paid: payment !== undefined });
      if (payment) receivedPayments.push(decodePaymentSignatureHeader(payment));
      next();
    });
    app.use(
      await createPaymentMiddleware({
        network,
        facilitator: { url: facilitatorUrl, apiKey },
        routes,
      }),
    );
    app.get('/weather', (_req, res) => {
      businessExecutions++;
      res.json({ forecast: 'sunny' });
    });
    app.get('/weather-upto', (_req, res) => {
      businessExecutions++;
      setSettlementOverrides(res, { amount: actualAmount });
      res.json({ forecast: 'sunny' });
    });
    sellerUrl = await listenLocally(app);
  }, 60000);

  beforeEach(() => {
    businessExecutions = 0;
    receivedPayments.length = 0;
    confirmedRequirements.length = 0;
    createdPayments.length = 0;
    receivedReceipts.length = 0;
    creationFailures.length = 0;
    hookEvents.length = 0;
    receivedRequests.length = 0;
  });
  afterAll(closeLocalServers);

  async function requestQuote(path: string, expectedAmount: string): Promise<PaymentRequired> {
    const response = await fetch(`${sellerUrl}${path}`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(15000),
    });
    expect(response.status).toBe(402);
    const header = response.headers.get('PAYMENT-REQUIRED');
    if (!header) throw new Error('Missing PAYMENT-REQUIRED');
    const quote = decodePaymentRequiredHeader(header);
    await response.arrayBuffer();
    expect(quote.x402Version).toBe(2);
    expect(quote.accepts).toHaveLength(1);
    expect(quote.accepts[0]).toMatchObject({ network, asset, payTo, amount: expectedAmount });
    expect(businessExecutions).toBe(0);
    return quote;
  }

  describe('authenticated Seller', () => {
    it('carries the configured Facilitator API key that authenticated capability discovery', () => {
      expect(typeof apiKey).toBe('string');
      expect(apiKey.length).toBeGreaterThan(0);
    });
  });

  describe('unpaid visitor', () => {
    it('sees the fixed price before buying a forecast', async () => {
      const quote = await requestQuote('/weather', exactAmount);
      expect(quote.accepts[0]?.scheme).toBe('exact');
    }, 60000);

    it('sees the usage ceiling and Kernel terms before authorizing a forecast', async () => {
      const quote = await requestQuote('/weather-upto', maxAmount);
      const requirement = quote.accepts[0];
      expect(requirement).toEqual({
        scheme: 'upto',
        network,
        amount: maxAmount,
        asset,
        payTo,
        maxTimeoutSeconds: 60,
        extra: {
          settlementContract: 'CBB7WCIQOBOJ4G7JUPVOA3RI553HBSYQ3GLBJ25X7W7S7MRJIGVCXRE3',
          facilitator: 'GAB7BFLQ5ZKR5W4RKEJ6GORIVXUXKEHZT4NZOKAMDXTV27BXGXN3MTNP',
          areFeesSponsored: true,
        },
      });
    }, 60000);
  });

  describe('paying Buyer', () => {
    let paidFetch: ReturnType<typeof createBuyerFetch>;
    let payer: string;
    let secret: string;

    beforeAll(() => {
      secret = process.env.BUYER_SECRET?.trim() || process.env.WEATHER_BUYER_SECRET?.trim() || '';
      if (!secret)
        throw new Error('Real payment integration requires BUYER_SECRET or WEATHER_BUYER_SECRET');
      if (!StrKey.isValidEd25519SecretSeed(secret))
        throw new Error('Buyer secret must be a valid testnet account seed');
      payer = Keypair.fromSecret(secret).publicKey();
      paidFetch = createBuyerFetch({
        secret,
        network,
        onPaymentRequired: async ({ paymentRequired, requestUrl }) => {
          hookEvents.push('required');
          expect(paymentRequired.accepts).toHaveLength(1);
          expect(paymentRequired.accepts[0]).toMatchObject({ network, asset, payTo });
          expect(requestUrl).toBe(paymentRequired.resource.url);
          expect(receivedPayments).toEqual([]);
          expect(businessExecutions).toBe(0);
        },
        onBeforePaymentCreation: async ({ selectedRequirements }) => {
          hookEvents.push('before');
          expect(receivedPayments).toEqual([]);
          expect(businessExecutions).toBe(0);
          confirmedRequirements.push(structuredClone(selectedRequirements));
        },
        onAfterPaymentCreation: async ({ paymentPayload }) => {
          hookEvents.push('after');
          expect(receivedPayments).toEqual([]);
          expect(businessExecutions).toBe(0);
          createdPayments.push(structuredClone(paymentPayload));
        },
        onPaymentCreationFailure: async ({ error }) => {
          creationFailures.push(error.message);
        },
        onPaymentResponse: async ({ paymentPayload, requirements, settleResponse }) => {
          hookEvents.push('response');
          expect(businessExecutions).toBe(1);
          expect(paymentPayload).toEqual(createdPayments[0]);
          expect(requirements).toEqual(confirmedRequirements[0]);
          if (!settleResponse) throw new Error('Missing native hook receipt');
          receivedReceipts.push(structuredClone(settleResponse));
        },
      });
    });

    async function requestForecast(path: string, scheme: string): Promise<Response> {
      const response = await paidFetch(
        new Request(`${sellerUrl}${path}`, {
          headers: { Accept: 'application/json' },
          signal: AbortSignal.timeout(90000),
        }),
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ forecast: 'sunny' });
      expect(businessExecutions).toBe(1);
      expect(receivedRequests).toEqual([
        { path, paid: false },
        { path, paid: true },
      ]);
      expect(receivedPayments).toHaveLength(1);
      const payment = receivedPayments[0];
      if (!payment?.accepted) throw new Error('Missing received v2 payment');
      const extra =
        scheme === 'exact'
          ? { areFeesSponsored: true }
          : {
              settlementContract: 'CBB7WCIQOBOJ4G7JUPVOA3RI553HBSYQ3GLBJ25X7W7S7MRJIGVCXRE3',
              facilitator: 'GAB7BFLQ5ZKR5W4RKEJ6GORIVXUXKEHZT4NZOKAMDXTV27BXGXN3MTNP',
              areFeesSponsored: true,
            };
      expect(payment.accepted).toEqual({
        scheme,
        network,
        asset,
        payTo,
        amount: scheme === 'exact' ? exactAmount : maxAmount,
        maxTimeoutSeconds: 60,
        extra,
      });
      expect(confirmedRequirements).toEqual([payment.accepted]);
      expect(createdPayments).toEqual(receivedPayments);
      expect(hookEvents).toEqual(['required', 'before', 'after', 'response']);
      expect(creationFailures).toEqual([]);
      expectSignedPayment(payment, payment.accepted, payer);
      return response;
    }

    async function confirmSettlement(
      scheme: string,
      response: Response,
      balanceBefore: bigint,
      expectedDebit: string,
    ) {
      const header = response.headers.get('PAYMENT-RESPONSE');
      if (!header) throw new Error('Missing payment receipt');
      const receipt = decodePaymentResponseHeader(header);
      expect(receivedReceipts).toEqual([receipt]);
      expect(receipt).toMatchObject({ success: true, network, payer });
      expect(receipt.transaction).toMatch(/^[a-f0-9]{64}$/i);
      const transaction = await getRpcClient(network).getTransaction(receipt.transaction);
      expect(transaction.status).toBe('SUCCESS');
      const settledAmount = balanceBefore - (await readTokenBalance(asset, payer, network));
      expect(settledAmount).toBe(BigInt(expectedDebit));
      process.stdout.write(
        `${JSON.stringify({
          kind: 'live-payment-evidence',
          scheme,
          network,
          payer,
          payTo,
          asset,
          authorizedAmount: scheme === 'exact' ? exactAmount : maxAmount,
          settledAmount: settledAmount.toString(),
          signatureVerified: true,
          businessExecutions,
          chainStatus: transaction.status,
          transaction: receipt.transaction,
        })}\n`,
      );
      return receipt;
    }

    it.each([
      { scheme: 'exact', path: '/weather', amount: exactAmount },
      { scheme: 'upto', path: '/weather-upto', amount: maxAmount },
    ])(
      'rejects the $scheme quote before sending payment',
      async ({ scheme, path, amount }) => {
        const declined: PaymentRequirements[] = [];
        const rejectPayment = createBuyerFetch({
          secret,
          network,
          onBeforePaymentCreation: async ({ selectedRequirements }) => {
            declined.push(structuredClone(selectedRequirements));
            return { abort: true, reason: 'User rejected payment' };
          },
        });
        await expect(
          rejectPayment(`${sellerUrl}${path}`, {
            signal: AbortSignal.timeout(90000),
          }),
        ).rejects.toThrow(
          'Failed to create payment payload: Payment creation aborted: User rejected payment',
        );
        expect(declined).toHaveLength(1);
        expect(declined[0]).toMatchObject({
          scheme,
          network,
          asset,
          payTo,
          amount,
          maxTimeoutSeconds: 60,
        });
        expect(receivedRequests).toEqual([{ path, paid: false }]);
        expect(receivedPayments).toEqual([]);
        expect(businessExecutions).toBe(0);
      },
      60000,
    );

    it('buys a forecast at the exact quoted price and receives a confirmed receipt', async () => {
      const balanceBefore = await readTokenBalance(asset, payer, network);
      const response = await requestForecast('/weather', 'exact');
      await confirmSettlement('exact', response, balanceBefore, exactAmount);
    }, 120000);

    it('authorizes a forecast ceiling and pays only the actual usage with upto', async () => {
      const balanceBefore = await readTokenBalance(asset, payer, network);
      const response = await requestForecast('/weather-upto', 'upto');
      const receipt = await confirmSettlement('upto', response, balanceBefore, actualAmount);
      expect(receipt.amount).toBe(actualAmount);
    }, 120000);
  });
});
