import type { PaymentPayload, PaymentRequirements } from '@x402/core/types';
import { SettleError, VerifyError } from '@x402/core/types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SafeHTTPFacilitatorClient } from '../../src/seller/facilitator-client.js';

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
const verify = {
  isValid: false,
  invalidReason: 'invalid_signature',
  invalidMessage: 'Signature rejected',
  payer: 'buyer',
};
const settle = {
  success: false,
  errorReason: 'settlement_pending',
  errorMessage: 'Awaiting confirmation',
  transaction: 'a'.repeat(64),
  network: requirement.network,
  payer: 'buyer',
};
const marker = 'SYNTHETIC_PRIVATE_RESPONSE';
afterEach(() => vi.unstubAllGlobals());

describe('SDK boundary using the official Facilitator client', () => {
  it.each(
    (['verify', 'settle'] as const).flatMap((operation) =>
      [200, 400, 500].map((status) => ({ operation, status })),
    ),
  )(
    'sanitizes a non-protocol $operation response with HTTP $status',
    async ({ operation, status }) => {
      vi.stubGlobal(
        'fetch',
        vi.fn<typeof fetch>().mockResolvedValue(Response.json({ unexpected: marker }, { status })),
      );
      const client = new SafeHTTPFacilitatorClient({ url: 'https://facilitator.example' });
      const error: unknown = await client[operation](payload, requirement).catch(
        (value: unknown) => value,
      );
      expect(error).toMatchObject({
        name: 'FacilitatorResponseError',
        message: `Facilitator ${operation} request failed`,
      });
      expect(String(error)).not.toContain(marker);
    },
  );

  it.each(['verify', 'settle'] as const)(
    'preserves the native %s rejection and all its fields',
    async (operation) => {
      vi.stubGlobal(
        'fetch',
        vi
          .fn<typeof fetch>()
          .mockResolvedValue(
            Response.json(operation === 'verify' ? verify : settle, { status: 400 }),
          ),
      );
      const client = new SafeHTTPFacilitatorClient({ url: 'https://facilitator.example' });
      const error: unknown = await client[operation](payload, requirement).catch(
        (value: unknown) => value,
      );
      if (operation === 'verify') {
        expect(error).toBeInstanceOf(VerifyError);
        expect(error).toMatchObject({
          statusCode: 400,
          invalidReason: verify.invalidReason,
          invalidMessage: verify.invalidMessage,
          payer: verify.payer,
        });
      } else {
        expect(error).toBeInstanceOf(SettleError);
        expect(error).toMatchObject({
          statusCode: 400,
          errorReason: settle.errorReason,
          errorMessage: settle.errorMessage,
          payer: settle.payer,
          network: settle.network,
          transaction: settle.transaction,
        });
      }
    },
  );

  it.each(
    (['verify', 'settle'] as const).flatMap((operation) =>
      [true, 'bad'].map((flag) => ({ operation, flag })),
    ),
  )('retains native non-2xx semantics for $operation flag $flag', async ({ operation, flag }) => {
    // Upstream discards the flag when constructing its error; the SDK cannot validate it afterward.
    const body =
      operation === 'verify' ? { ...verify, isValid: flag } : { ...settle, success: flag };
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockResolvedValue(Response.json(body, { status: 400 })),
    );
    const client = new SafeHTTPFacilitatorClient({ url: 'https://facilitator.example' });
    const error: unknown = await client[operation](payload, requirement).catch(
      (value: unknown) => value,
    );
    expect(error).toBeInstanceOf(operation === 'verify' ? VerifyError : SettleError);
    expect(error).toMatchObject({ statusCode: 400, payer: 'buyer' });
    expect(error).not.toHaveProperty(operation === 'verify' ? 'isValid' : 'success');
  });

  it.each(['verify', 'settle'] as const)(
    'uses native validation for malformed %s success-status JSON',
    async (operation) => {
      const body =
        operation === 'verify'
          ? { ...verify, isValid: 'bad', invalidMessage: marker }
          : { ...settle, success: 'bad', errorMessage: marker };
      vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(Response.json(body)));
      const client = new SafeHTTPFacilitatorClient({ url: 'https://facilitator.example' });
      await expect(client[operation](payload, requirement)).rejects.toMatchObject({
        name: 'FacilitatorResponseError',
        message: `Facilitator ${operation} request failed`,
      });
    },
  );

  it.each(['verify', 'settle'] as const)('hides arbitrary %s fetch failures', async (operation) => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockRejectedValue(new Error(marker)));
    const client = new SafeHTTPFacilitatorClient({ url: 'https://facilitator.example' });
    await expect(client[operation](payload, requirement)).rejects.toMatchObject({
      name: 'FacilitatorResponseError',
      message: `Facilitator ${operation} request failed`,
    });
  });
});
