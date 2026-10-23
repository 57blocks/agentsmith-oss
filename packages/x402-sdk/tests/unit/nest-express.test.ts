import 'reflect-metadata';
import { Controller, Get, Module, UnprocessableEntityException } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Server } from 'node:http';
import request from 'supertest';
import { StrKey } from '@stellar/stellar-sdk';
import { HTTPFacilitatorClient } from '@x402/core/server';
import type { PaymentPayload, SettleResponse, SupportedResponse } from '@x402/core/types';
import {
  decodePaymentRequiredHeader,
  decodePaymentResponseHeader,
  encodePaymentSignatureHeader,
} from '@x402/core/http';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MockInstance } from 'vitest';
import { createPaymentMiddleware } from '../../src/seller/express.js';

const asset = StrKey.encodeContract(Buffer.alloc(32, 10));
const payTo = StrKey.encodeEd25519PublicKey(Buffer.alloc(32, 11));
const receipt: SettleResponse = {
  success: true,
  network: 'stellar:testnet',
  transaction: 'a'.repeat(64),
};
const supported: SupportedResponse = {
  kinds: [
    {
      x402Version: 2,
      scheme: 'exact',
      network: 'stellar:testnet',
      extra: { areFeesSponsored: true },
    },
  ],
  extensions: [],
  signers: {},
};
let events: string[] = [];

@Controller()
class WeatherController {
  @Get('weather')
  async forecast() {
    events.push('controller');
    return { forecast: 'sunny' };
  }

  @Get('failure')
  failure() {
    events.push('controller');
    throw new UnprocessableEntityException('forecast unavailable');
  }

  @Get('health')
  health() {
    return { status: 'ok' };
  }
}

@Module({ controllers: [WeatherController] })
class SellerModule {}

describe('Nest Express behavior with mocked Facilitator responses', () => {
  let app: INestApplication | undefined;
  let httpServer: Server;
  let verify: MockInstance<HTTPFacilitatorClient['verify']>;
  let settle: MockInstance<HTTPFacilitatorClient['settle']>;

  beforeAll(async () => {
    vi.spyOn(HTTPFacilitatorClient.prototype, 'getSupported').mockResolvedValue(supported);
    verify = vi.spyOn(HTTPFacilitatorClient.prototype, 'verify');
    settle = vi.spyOn(HTTPFacilitatorClient.prototype, 'settle');
    const middleware = await createPaymentMiddleware({
      network: 'stellar:testnet',
      facilitator: { url: 'https://facilitator.example.com' },
      routes: {
        'GET /api/weather': {
          accepts: { scheme: 'exact', payTo, price: { asset, amount: '10000' } },
        },
        'GET /api/failure': {
          accepts: { scheme: 'exact', payTo, price: { asset, amount: '10000' } },
        },
      },
    });
    app = await NestFactory.create(SellerModule, { logger: false, abortOnError: false });
    app.setGlobalPrefix('api');
    app.use(middleware);
    await app.listen(0, '127.0.0.1');
    const listener: unknown = app.getHttpServer();
    if (!(listener instanceof Server))
      throw new Error('Nest Express must expose a Node HTTP server');
    httpServer = listener;
  });
  beforeEach(() => {
    events = [];
    verify.mockClear().mockImplementation(async () => {
      events.push('verify');
      return { isValid: true };
    });
    settle.mockClear().mockImplementation(async () => {
      events.push('settle');
      return receipt;
    });
  });
  afterAll(async () => {
    await app?.close();
    vi.restoreAllMocks();
  });

  async function paymentHeader(path: string): Promise<string> {
    const unpaid = await request(httpServer).get(path).set('Accept', 'application/json');
    expect(unpaid.status).toBe(402);
    const challenge = decodePaymentRequiredHeader(String(unpaid.headers['payment-required']));
    const payload: PaymentPayload = {
      x402Version: 2,
      accepted: challenge.accepts[0]!,
      payload: { transaction: 'component-test-envelope' },
    };
    return encodePaymentSignatureHeader(payload);
  }

  it('protects a prefixed Controller without executing it for an unpaid request', async () => {
    const response = await request(httpServer)
      .get('/api/weather')
      .set('Accept', 'application/json');
    expect(response.status).toBe(402);
    const challenge = decodePaymentRequiredHeader(String(response.headers['payment-required']));
    expect(challenge.x402Version).toBe(2);
    expect(challenge.accepts).toHaveLength(1);
    expect(challenge.accepts[0]).toMatchObject({
      scheme: 'exact',
      network: 'stellar:testnet',
      asset,
      amount: '10000',
      payTo,
      extra: { areFeesSponsored: true },
    });
    expect(events).toEqual([]);
    expect(verify).not.toHaveBeenCalled();
    expect(settle).not.toHaveBeenCalled();
  });
  it('returns an async Controller result and receipt after settlement', async () => {
    const header = await paymentHeader('/api/weather');
    const response = await request(httpServer).get('/api/weather').set('PAYMENT-SIGNATURE', header);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ forecast: 'sunny' });
    expect(events).toEqual(['verify', 'controller', 'settle']);
    expect(decodePaymentResponseHeader(String(response.headers['payment-response']))).toEqual(
      receipt,
    );
    expect(verify).toHaveBeenCalledOnce();
    expect(settle).toHaveBeenCalledOnce();
  });
  it('preserves Nest exception responses without settlement', async () => {
    const header = await paymentHeader('/api/failure');
    const response = await request(httpServer).get('/api/failure').set('PAYMENT-SIGNATURE', header);
    expect(response.status).toBe(422);
    expect(response.body).toEqual({
      message: 'forecast unavailable',
      error: 'Unprocessable Entity',
      statusCode: 422,
    });
    expect(events).toEqual(['verify', 'controller']);
    expect(settle).not.toHaveBeenCalled();
    expect(response.headers).not.toHaveProperty('payment-response');
  });
  it('serves unprotected Controllers without payment operations', async () => {
    const response = await request(httpServer).get('/api/health');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'ok' });
    expect(verify).not.toHaveBeenCalled();
    expect(settle).not.toHaveBeenCalled();
  });
});
