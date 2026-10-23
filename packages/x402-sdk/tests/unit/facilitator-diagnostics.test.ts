import { inspect } from 'node:util';
import { FacilitatorResponseError, FacilitatorTimeoutError } from '@x402/core/server';
import type { PaymentPayload, PaymentRequirements } from '@x402/core/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SafeHTTPFacilitatorClient } from '../../src/seller/facilitator-client.js';
import {
  createResourceServer,
  ResourceServerInitializationError,
} from '../../src/seller/resource-server.js';
import type { ResourceServerConfig } from '../../src/seller/resource-server.js';

const secret = 'SYNTHETIC_PRIVATE_CREDENTIAL';
const body = 'SYNTHETIC_PRIVATE_BODY';
const config: ResourceServerConfig = {
  network: 'stellar:pubnet',
  facilitator: { url: 'https://facilitator.example', apiKey: secret, timeoutMs: 45000 },
};
const requirement: PaymentRequirements = {
  scheme: 'exact',
  network: 'stellar:testnet',
  asset: 'test-token',
  payTo: 'seller',
  amount: '40000',
  maxTimeoutSeconds: 60,
  extra: {},
};
const payload: PaymentPayload = { x402Version: 2, accepted: requirement, payload: {} };

let warningCalls: unknown[];

beforeEach(() => {
  warningCalls = vi.spyOn(console, 'warn').mockImplementation(() => {}).mock.calls;
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function initializationError(): Promise<ResourceServerInitializationError> {
  const error: unknown = await createResourceServer(config).catch((value: unknown) => value);
  if (!(error instanceof ResourceServerInitializationError)) {
    throw new Error('Expected resource server initialization failure');
  }
  return error;
}

function expectPrivateDataExcluded(error: unknown): void {
  const rendered = inspect({ error, warnings: warningCalls }, { depth: null });
  expect(rendered).not.toContain(secret);
  expect(rendered).not.toContain(body);
}

describe('safe initialization diagnostic causes', () => {
  it('retains the supported deadline through native initialization without retaining the raw error', async () => {
    const raw = new FacilitatorTimeoutError('supported', 45000);
    raw.message = secret;
    raw.cause = new Error(body);
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockRejectedValue(raw));

    const error = await initializationError();
    expect(error.message).toBe('Unable to initialize the configured x402 resource server');
    expect(error.cause).toBeInstanceOf(FacilitatorTimeoutError);
    expect(error.cause).toMatchObject({
      name: 'FacilitatorTimeoutError',
      operation: 'supported',
      timeoutMs: 45000,
      message: 'Facilitator supported request timed out after 45000ms',
    });
    expect(error.cause).not.toBe(raw);
    expect(error.cause).not.toHaveProperty('cause');
    expectPrivateDataExcluded(error);
  });

  it.each(['ENOTFOUND', 'ECONNREFUSED', 'CERT_HAS_EXPIRED', 'ERR_TLS_CERT_ALTNAME_INVALID'])(
    'retains %s across native discovery while removing messages, headers and body',
    async (code) => {
      const raw = Object.assign(new Error(secret), {
        code,
        headers: { Authorization: secret },
        body,
      });
      vi.stubGlobal(
        'fetch',
        vi.fn<typeof fetch>().mockRejectedValue(new TypeError(body, { cause: raw })),
      );

      const error = await initializationError();
      expect(error.cause).toBeInstanceOf(FacilitatorResponseError);
      expect(error.cause).toMatchObject({
        name: 'FacilitatorResponseError',
        message: 'Facilitator supported request failed',
        operation: 'supported',
        code,
      });
      expect(error.cause).not.toHaveProperty('cause');
      expect(error.cause).not.toHaveProperty('headers');
      expect(error.cause).not.toHaveProperty('body');
      expectPrivateDataExcluded(error);
    },
  );

  it.each([401, 503, 200])(
    'keeps HTTP %s response contents out of causes and native warnings',
    async (status) => {
      vi.stubGlobal(
        'fetch',
        vi.fn<typeof fetch>().mockResolvedValue(Response.json({ secret, body }, { status })),
      );

      const error = await initializationError();
      expect(error.cause).toBeInstanceOf(FacilitatorResponseError);
      expect(error.cause).toMatchObject({
        message: 'Facilitator supported request failed',
        operation: 'supported',
      });
      // This upstream endpoint provides no structured HTTP status on its thrown error.
      expect(error.cause).not.toHaveProperty('statusCode');
      expect(error.cause).not.toHaveProperty('code');
      expectPrivateDataExcluded(error);
    },
  );

  it('drops unknown error codes and nested private properties', async () => {
    const raw = Object.assign(new Error(body), { code: secret, response: { body, secret } });
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockRejectedValue(new Error(secret, { cause: raw })),
    );

    const error = await initializationError();
    expect(error.cause).toMatchObject({
      message: 'Facilitator supported request failed',
      operation: 'supported',
    });
    expect(error.cause).not.toHaveProperty('code');
    expect(error.cause).not.toHaveProperty('cause');
    expectPrivateDataExcluded(error);
  });

  it('terminates cyclic causes without exposing the original error', async () => {
    const raw = new Error(secret);
    raw.cause = raw;
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockRejectedValue(raw));

    const error = await initializationError();
    expect(error.cause).toMatchObject({
      message: 'Facilitator supported request failed',
      operation: 'supported',
    });
    expect(error.cause).not.toHaveProperty('cause');
    expectPrivateDataExcluded(error);
  });

  it('sanitizes direct construction and keeps no-argument construction compatible', () => {
    const raw = Object.assign(new Error(secret), { code: 'ENOTFOUND', body });
    const error = new ResourceServerInitializationError(new Error(body, { cause: raw }));
    expect(error.cause).toMatchObject({
      message: 'Facilitator supported request failed',
      operation: 'supported',
      code: 'ENOTFOUND',
    });
    expect(error.cause).not.toHaveProperty('cause');
    expectPrivateDataExcluded(error);
    expect(new ResourceServerInitializationError().cause).toBeUndefined();
  });
});

describe('diagnostics retain native Facilitator response error compatibility', () => {
  it.each(
    (['supported', 'verify', 'settle'] as const).flatMap((operation) =>
      ['ENOTFOUND', 'CERT_HAS_EXPIRED'].map((code) => ({ operation, code })),
    ),
  )(
    'reports $operation and $code without changing native error classification',
    async ({ operation, code }) => {
      const raw = Object.assign(new Error(secret), { code, body });
      vi.stubGlobal(
        'fetch',
        vi.fn<typeof fetch>().mockRejectedValue(new TypeError(body, { cause: raw })),
      );
      const client = new SafeHTTPFacilitatorClient({ url: 'https://facilitator.example' });
      const request =
        operation === 'supported' ? client.getSupported() : client[operation](payload, requirement);
      const error: unknown = await request.catch((value: unknown) => value);
      expect(error).toBeInstanceOf(FacilitatorResponseError);
      expect(error).toMatchObject({
        name: 'FacilitatorResponseError',
        message: `Facilitator ${operation} request failed`,
        operation,
        code,
      });
      expect(error).not.toHaveProperty('cause');
      expectPrivateDataExcluded(error);
    },
  );
});
