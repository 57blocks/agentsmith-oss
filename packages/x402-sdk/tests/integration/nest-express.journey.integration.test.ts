import 'reflect-metadata';
import { loadEnvFile } from 'node:process';
import { existsSync } from 'node:fs';
import { Controller, Get, Module } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { getUsdcAddress } from '@x402/stellar';
import { decodePaymentRequiredHeader } from '@x402/core/http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPaymentMiddleware } from 'agentsmith-x402-sdk/seller/express';

let businessExecutions = 0;

@Controller('weather')
class WeatherController {
  @Get()
  async forecast() {
    businessExecutions++;
    return { forecast: 'sunny' };
  }
}

@Module({ controllers: [WeatherController] })
class SellerModule {}

const network = 'stellar:testnet';
const asset = getUsdcAddress(network);
const amount = '40000';

describe('Nest Express Seller journey', () => {
  let app: INestApplication | undefined;
  let sellerUrl: string;
  let payTo: string;

  beforeAll(async () => {
    if (existsSync('.env.integration')) loadEnvFile('.env.integration');
    const address = process.env.SELLER_ADDRESS?.trim() || process.env.X402_PAY_TO?.trim();
    if (!address) throw new Error('Set SELLER_ADDRESS or X402_PAY_TO for the integration Seller');
    payTo = address;
    const middleware = await createPaymentMiddleware({
      network,
      facilitator: { url: 'https://testnet.agentsmith.xyz/facilitator' },
      routes: {
        'GET /api/weather': { accepts: { scheme: 'exact', payTo, price: { asset, amount } } },
      },
    });
    app = await NestFactory.create(SellerModule, { logger: false, abortOnError: false });
    app.setGlobalPrefix('api');
    app.use(middleware);
    await app.listen(0, '127.0.0.1');
    sellerUrl = await app.getUrl();
  }, 60000);
  beforeEach(() => {
    businessExecutions = 0;
  });
  afterAll(async () => {
    await app?.close();
  });

  describe('unpaid visitor', () => {
    it('sees the prefixed API price before the Controller runs', async () => {
      const response = await fetch(`${sellerUrl}/api/weather`, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(15000),
      });
      expect(response.status).toBe(402);
      const header = response.headers.get('PAYMENT-REQUIRED');
      if (!header) throw new Error('Missing PAYMENT-REQUIRED');
      const challenge = decodePaymentRequiredHeader(header);
      await response.arrayBuffer();
      expect(challenge.accepts).toHaveLength(1);
      expect(challenge.accepts[0]).toMatchObject({
        scheme: 'exact',
        network,
        asset,
        amount,
        payTo,
      });
      expect(businessExecutions).toBe(0);
    }, 60000);
  });
});
