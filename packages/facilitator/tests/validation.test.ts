import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import {
  FacilitatorRequestDto,
  PaymentPayloadDto,
  PaymentRequirementsDto,
} from '../src/modules/x402/dto/facilitator-request.dto.js';
import { FacilitatorValidationPipe } from '../src/modules/x402/dto/facilitator-validation.pipe.js';

function request(maxTimeoutSeconds: unknown = 60) {
  const requirements = {
    scheme: 'upto',
    network: 'stellar:testnet',
    amount: '40000',
    asset: 'C_TOKEN',
    payTo: 'G_PAYEE',
    maxTimeoutSeconds,
    extra: {},
  };
  return {
    x402Version: 2,
    paymentPayload: { x402Version: 2, accepted: requirements, payload: {} },
    paymentRequirements: requirements,
  };
}

async function parse(body: unknown, operation: 'verify' | 'settle' = 'verify') {
  const result: unknown = await new FacilitatorValidationPipe(operation).transform(body, {
    type: 'body',
  });
  expect(result).toBeInstanceOf(FacilitatorRequestDto);
  if (!(result instanceof FacilitatorRequestDto)) throw new Error('Expected a validated DTO');
  return result;
}

describe('payment request DTO validation', () => {
  it('creates nested DTOs even when parameter reflection metadata is absent', async () => {
    const parsed = await parse(request());
    expect(parsed.paymentPayload).toBeInstanceOf(PaymentPayloadDto);
    expect(parsed.paymentPayload.accepted).toBeInstanceOf(PaymentRequirementsDto);
    expect(parsed.paymentRequirements).toBeInstanceOf(PaymentRequirementsDto);
    expect(parsed).toEqual(request());
  });

  it.each([1, 300])('accepts the inclusive timeout bound %s', async (seconds) => {
    await expect(parse(request(seconds))).resolves.toBeInstanceOf(FacilitatorRequestDto);
  });

  it.each([0, -1, 301, 1.5, '60', null])('rejects invalid timeout %s', async (seconds) => {
    await expect(parse(request(seconds))).rejects.toMatchObject({ status: 400 });
  });

  it('supplies independent empty extra objects when they are omitted', async () => {
    const body = request();
    const { extra: _extra, ...withoutExtra } = body.paymentRequirements;
    const parsed = await parse({
      ...body,
      paymentPayload: { ...body.paymentPayload, accepted: withoutExtra },
      paymentRequirements: withoutExtra,
    });
    expect(parsed.paymentRequirements.extra).toEqual({});
    expect(parsed.paymentPayload.accepted.extra).toEqual({});
    expect(parsed.paymentRequirements.extra).not.toBe(parsed.paymentPayload.accepted.extra);
  });

  it('preserves scheme and extension fields while dropping unknown top-level fields', async () => {
    const body = request();
    const terms = { ...body.paymentRequirements, futureField: 'kept', extra: { fee: true } };
    const payload = {
      ...body.paymentPayload,
      accepted: terms,
      payload: { transaction: 'signed-xdr' },
      resource: { url: 'https://example.com/weather', futureField: true },
      extensions: { bazaar: { info: { nested: ['kept'] } } },
      futurePayloadField: 'kept',
    };
    const parsed = await parse({
      ...body,
      paymentPayload: payload,
      paymentRequirements: terms,
      ignored: 'not part of the envelope',
    });
    expect(parsed.paymentPayload).toEqual(payload);
    expect(parsed.paymentRequirements).toEqual(terms);
    expect(parsed).not.toHaveProperty('ignored');
  });

  it.each([1, '2', null])('rejects invalid top-level version %s', async (version) => {
    await expect(parse({ ...request(), x402Version: version })).rejects.toMatchObject({
      status: 400,
      response: { isValid: false, invalidReason: 'invalid_x402_version' },
    });
  });

  it('rejects a non-v2 payload even when the envelope version is valid', async () => {
    const body = request();
    await expect(
      parse({ ...body, paymentPayload: { ...body.paymentPayload, x402Version: 1 } }),
    ).rejects.toMatchObject({
      status: 400,
      response: { invalidReason: 'invalid_x402_version' },
    });
  });

  it.each([40000, '1.5', '-1', ''])('rejects non-atomic-string amount %s', async (amount) => {
    const body = request();
    await expect(
      parse({ ...body, paymentRequirements: { ...body.paymentRequirements, amount } }),
    ).rejects.toMatchObject({
      status: 400,
      response: { invalidReason: 'invalid_payment_requirements' },
    });
  });

  it.each([undefined, null, [], 'invalid'])(
    'rejects missing or non-object terms %s',
    async (terms) => {
      await expect(parse({ ...request(), paymentRequirements: terms })).rejects.toMatchObject({
        status: 400,
      });
    },
  );

  it.each(['payload', 'resource', 'extensions'])(
    'rejects null or array %s objects',
    async (field) => {
      const body = request();
      for (const value of [null, []]) {
        await expect(
          parse({ ...body, paymentPayload: { ...body.paymentPayload, [field]: value } }),
        ).rejects.toMatchObject({ status: 400, response: { invalidReason: 'invalid_payload' } });
      }
    },
  );

  it('rejects null extra instead of turning it into a missing object', async () => {
    const body = request();
    await expect(
      parse({ ...body, paymentRequirements: { ...body.paymentRequirements, extra: null } }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it.each([undefined, null, [], 2, 'body'])('rejects non-envelope input %s', async (body) => {
    await expect(parse(body)).rejects.toMatchObject({ status: 400 });
  });

  it('keeps the settle response shape and network without reflecting input values', async () => {
    const body = request();
    const error: unknown = await parse(
      {
        ...body,
        paymentRequirements: { ...body.paymentRequirements, amount: 'secret-input-value' },
      },
      'settle',
    ).catch((error: unknown) => error);
    expect(error).toMatchObject({
      status: 400,
      response: {
        success: false,
        errorReason: 'invalid_payment_requirements',
        errorMessage: expect.stringContaining('paymentRequirements.amount'),
        transaction: '',
        network: 'stellar:testnet',
      },
    });
    expect(JSON.stringify(error)).not.toContain('secret-input-value');
  });

  it('does not share the rejected network between concurrent requests', async () => {
    const pipe = new FacilitatorValidationPipe('settle');
    const errors = await Promise.all(
      ['stellar:testnet', 'stellar:pubnet'].map(async (network) => {
        try {
          await pipe.transform(
            { ...request(), paymentRequirements: { network, amount: 'invalid' } },
            { type: 'body' },
          );
        } catch (error) {
          return error;
        }
        throw new Error('Expected validation rejection');
      }),
    );
    expect(errors[0]).toMatchObject({ response: { network: 'stellar:testnet' } });
    expect(errors[1]).toMatchObject({ response: { network: 'stellar:pubnet' } });
  });
});
