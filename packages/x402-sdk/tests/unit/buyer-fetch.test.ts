import { getNetworkPassphrase } from '@x402/stellar';
import { Address, Keypair, StrKey, hash, nativeToScVal, xdr } from '@stellar/stellar-sdk';
import type { ClientStellarSigner, RpcConfig } from '@x402/stellar';
import type {
  AfterPaymentCreationHook,
  BeforePaymentCreationHook,
  OnPaymentCreationFailureHook,
  OnPaymentResponseHook,
  PaymentRequiredHook,
} from '@x402/core/client';
import type { PaymentRequirements, SettleResponse } from '@x402/core/types';
import {
  decodePaymentSignatureHeader,
  encodePaymentRequiredHeader,
  encodePaymentResponseHeader,
} from '@x402/core/http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBuyerFetch } from '../../src/buyer.js';

const boundary = vi.hoisted(() => ({ construct: vi.fn(), create: vi.fn() }));
vi.mock('@x402/stellar/exact/client', () => ({
  ExactStellarScheme: class {
    readonly scheme = 'exact';
    constructor(
      private readonly signer: ClientStellarSigner,
      rpc?: RpcConfig,
    ) {
      boundary.construct('exact', signer.address, rpc);
    }
    createPaymentPayload(version: number, requirements: PaymentRequirements) {
      return boundary.create(this.signer, version, requirements);
    }
  },
}));
vi.mock('../../src/schemes/upto/client.js', () => ({
  UptoStellarClient: class {
    readonly scheme = 'upto';
    constructor(
      private readonly signer: ClientStellarSigner,
      rpc?: RpcConfig,
    ) {
      boundary.construct('upto', signer.address, rpc);
    }
    createPaymentPayload(version: number, requirements: PaymentRequirements) {
      return boundary.create(this.signer, version, requirements);
    }
  },
}));
const keypair = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 1));
const secret = keypair.secret();
const network = 'stellar:testnet';
const url = 'https://seller.example/weather';
const requirement: PaymentRequirements = {
  scheme: 'exact',
  network,
  asset: StrKey.encodeContract(Buffer.alloc(32, 2)),
  payTo: StrKey.encodeEd25519PublicKey(Buffer.alloc(32, 3)),
  amount: '40000',
  maxTimeoutSeconds: 60,
  extra: { areFeesSponsored: true },
};
function authorizationPreimage(quote: PaymentRequirements): string {
  return xdr.HashIdPreimage.envelopeTypeSorobanAuthorization(
    new xdr.HashIdPreimageSorobanAuthorization({
      networkId: hash(Buffer.from(getNetworkPassphrase(quote.network))),
      nonce: xdr.Int64.fromString('1'),
      signatureExpirationLedger: 112,
      invocation: new xdr.SorobanAuthorizedInvocation({
        function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
          new xdr.InvokeContractArgs({
            contractAddress: Address.fromString(quote.asset).toScAddress(),
            functionName: 'transfer',
            args: [
              nativeToScVal(keypair.publicKey(), { type: 'address' }),
              nativeToScVal(quote.payTo, { type: 'address' }),
              nativeToScVal(quote.amount, { type: 'i128' }),
            ],
          }),
        ),
        subInvocations: [],
      }),
    }),
  ).toXDR('base64');
}
const preimage = authorizationPreimage(requirement);
let transport: ReturnType<typeof vi.fn<typeof fetch>>;
beforeEach(() => {
  vi.resetAllMocks();
  transport = vi.fn<typeof fetch>();
  vi.stubGlobal('fetch', transport);
  boundary.create.mockImplementation(
    async (signer: ClientStellarSigner, version: number, quote: PaymentRequirements) => {
      const result = await signer.signAuthEntry(authorizationPreimage(quote));
      if (result.error) throw new Error(result.error.message);
      return { x402Version: version, payload: { transaction: result.signedAuthEntry } };
    },
  );
});
afterEach(() => vi.unstubAllGlobals());

describe('one-call Node Buyer setup', () => {
  it('creates exact and upto for the supplied account without sending or signing', () => {
    createBuyerFetch({ secret, network });
    expect(boundary.construct.mock.calls).toEqual([
      ['exact', keypair.publicKey(), undefined],
      ['upto', keypair.publicKey(), undefined],
    ]);
    expect(transport).not.toHaveBeenCalled();
    expect(boundary.create).not.toHaveBeenCalled();
  });

  it.each(['exact', 'upto'])(
    'signs and resends a %s purchase with the configured local signer',
    async (scheme) => {
      const accepted = { ...requirement, scheme };
      const response = new Response('forecast');
      transport
        .mockResolvedValueOnce(
          new Response('', {
            status: 402,
            headers: {
              'PAYMENT-REQUIRED': encodePaymentRequiredHeader({
                x402Version: 2,
                resource: { url, description: 'Weather', mimeType: 'text/plain' },
                accepts: [accepted],
              }),
            },
          }),
        )
        .mockResolvedValueOnce(response);
      const paidFetch = createBuyerFetch({ secret, network });
      expect(await paidFetch(new Request(url, { method: 'POST', body: 'Shanghai' }))).toBe(
        response,
      );
      expect(await response.text()).toBe('forecast');
      expect(transport).toHaveBeenCalledTimes(2);
      const requests = transport.mock.calls.map(([input]) => {
        if (!(input instanceof Request)) throw new Error('Expected Request');
        return input;
      });
      expect(requests[0]?.headers.get('PAYMENT-SIGNATURE')).toBeNull();
      expect(await requests[0]?.text()).toBe('Shanghai');
      expect(await requests[1]?.text()).toBe('Shanghai');
      const header = requests[1]?.headers.get('PAYMENT-SIGNATURE');
      if (!header) throw new Error('Missing payment');
      const payment = decodePaymentSignatureHeader(header);
      expect(payment.accepted).toEqual(accepted);
      const signature = payment.payload.transaction;
      if (typeof signature !== 'string') throw new Error('Missing signature');
      expect(
        keypair.verify(hash(Buffer.from(preimage, 'base64')), Buffer.from(signature, 'base64')),
      ).toBe(true);
      expect(boundary.create).toHaveBeenCalledOnce();
    },
  );

  it('passes optional RPC and scheme registration to the native client', () => {
    const rpcConfig = { url: 'https://rpc.example' };
    createBuyerFetch({ secret, network, rpcConfig, schemes: ['upto'] });
    expect(boundary.construct.mock.calls).toEqual([['upto', keypair.publicKey(), rpcConfig]]);
  });

  it('rejects an invalid secret at setup without HTTP calls', () => {
    expect(() => createBuyerFetch({ secret: 'invalid', network })).toThrow(
      'invalid encoded string',
    );
    expect(transport).not.toHaveBeenCalled();
    expect(boundary.construct).not.toHaveBeenCalled();
  });
});

function quoted(accepted = requirement) {
  return {
    x402Version: 2,
    resource: { url, description: 'Weather', mimeType: 'text/plain' },
    accepts: [accepted],
  };
}
function challenge(accepted = requirement): Response {
  return new Response('', {
    status: 402,
    headers: {
      'PAYMENT-REQUIRED': encodePaymentRequiredHeader(quoted(accepted)),
    },
  });
}
function approvalGate() {
  let approve!: () => void;
  const promise = new Promise<void>((resolve) => {
    approve = resolve;
  });
  return { promise, approve };
}

describe('native Buyer confirmation', () => {
  it.each(['exact', 'upto'])(
    'waits for approval of the selected %s quote before signing',
    async (scheme) => {
      const accepted = { ...requirement, scheme };
      const gate = approvalGate();
      const confirm = vi.fn<BeforePaymentCreationHook>(async () => gate.promise);
      transport
        .mockResolvedValueOnce(challenge(accepted))
        .mockResolvedValueOnce(new Response('forecast'));
      const paidFetch = createBuyerFetch({ secret, network, onBeforePaymentCreation: confirm });
      const result = paidFetch(url);
      await vi.waitFor(() =>
        expect(confirm).toHaveBeenCalledExactlyOnceWith({
          paymentRequired: quoted(accepted),
          selectedRequirements: accepted,
        }),
      );
      expect(boundary.create).not.toHaveBeenCalled();
      expect(transport).toHaveBeenCalledOnce();
      gate.approve();
      expect(await (await result).text()).toBe('forecast');
      expect(boundary.create).toHaveBeenCalledOnce();
      expect(transport).toHaveBeenCalledTimes(2);
    },
  );

  it.each(['exact', 'upto'])('does not sign or resend a rejected %s quote', async (scheme) => {
    const accepted = { ...requirement, scheme };
    const confirm = vi.fn<BeforePaymentCreationHook>(async () => ({
      abort: true,
      reason: 'User rejected payment',
    }));
    transport.mockResolvedValueOnce(challenge(accepted));
    const paidFetch = createBuyerFetch({ secret, network, onBeforePaymentCreation: confirm });
    await expect(paidFetch(url)).rejects.toThrow('Payment creation aborted: User rejected payment');
    expect(confirm).toHaveBeenCalledExactlyOnceWith({
      paymentRequired: quoted(accepted),
      selectedRequirements: accepted,
    });
    expect(boundary.create).not.toHaveBeenCalled();
    expect(transport).toHaveBeenCalledOnce();
  });

  it('stops before signing when the confirmation UI fails', async () => {
    transport.mockResolvedValueOnce(challenge());
    const paidFetch = createBuyerFetch({
      secret,
      network,
      onBeforePaymentCreation: async () => {
        throw new Error('Confirmation UI failed');
      },
    });
    await expect(paidFetch(url)).rejects.toThrow(
      'Failed to create payment payload: Confirmation UI failed',
    );
    expect(boundary.create).not.toHaveBeenCalled();
    expect(transport).toHaveBeenCalledOnce();
  });

  it('does not request approval for an ordinary response', async () => {
    const confirm = vi.fn<BeforePaymentCreationHook>(async () => undefined);
    const response = new Response('free forecast');
    transport.mockResolvedValueOnce(response);
    const paidFetch = createBuyerFetch({ secret, network, onBeforePaymentCreation: confirm });
    expect(await paidFetch(url)).toBe(response);
    expect(confirm).not.toHaveBeenCalled();
    expect(boundary.create).not.toHaveBeenCalled();
  });

  it('requests fresh confirmation for each purchase on the same fetch function', async () => {
    const confirm = vi.fn<BeforePaymentCreationHook>(async () => undefined);
    transport
      .mockResolvedValueOnce(challenge())
      .mockResolvedValueOnce(new Response('first'))
      .mockResolvedValueOnce(challenge({ ...requirement, amount: '80000' }))
      .mockResolvedValueOnce(new Response('second'));
    const paidFetch = createBuyerFetch({ secret, network, onBeforePaymentCreation: confirm });
    expect(await (await paidFetch(url)).text()).toBe('first');
    expect(await (await paidFetch(url)).text()).toBe('second');
    expect(confirm.mock.calls.map(([context]) => context.selectedRequirements.amount)).toEqual([
      '40000',
      '80000',
    ]);
    expect(boundary.create).toHaveBeenCalledTimes(2);
  });

  it('keeps concurrent purchases behind their own confirmations', async () => {
    const gate = approvalGate();
    const confirm = vi.fn<BeforePaymentCreationHook>(async ({ selectedRequirements }) => {
      if (selectedRequirements.amount === '40000') await gate.promise;
    });
    transport.mockImplementation(async (input) => {
      if (!(input instanceof Request)) throw new Error('Expected Request');
      if (input.headers.has('PAYMENT-SIGNATURE')) return new Response('forecast');
      return challenge({
        ...requirement,
        amount: input.url.endsWith('/second') ? '80000' : '40000',
      });
    });
    const paidFetch = createBuyerFetch({ secret, network, onBeforePaymentCreation: confirm });
    const pending = paidFetch(url);
    await vi.waitFor(() => expect(confirm).toHaveBeenCalledOnce());
    expect(await (await paidFetch(`${url}/second`)).text()).toBe('forecast');
    expect(boundary.create.mock.calls.map((call) => call[2].amount)).toEqual(['80000']);
    gate.approve();
    expect(await (await pending).text()).toBe('forecast');
    expect(boundary.create.mock.calls.map((call) => call[2].amount)).toEqual(['80000', '40000']);
    expect(transport).toHaveBeenCalledTimes(4);
  });
});

const receipt = {
  success: true,
  network,
  payer: keypair.publicKey(),
  transaction: 'a'.repeat(64),
} satisfies SettleResponse;
function createdPayment() {
  return {
    x402Version: 2,
    resource: quoted().resource,
    accepted: requirement,
    extensions: undefined,
    payload: { transaction: 'signed-payload' },
  };
}
function paidResponse(settlement: SettleResponse = receipt): Response {
  return new Response('forecast', {
    headers: {
      'PAYMENT-RESPONSE': encodePaymentResponseHeader(settlement),
    },
  });
}

describe('public Buyer lifecycle hooks', () => {
  beforeEach(() =>
    boundary.create.mockResolvedValue({
      x402Version: 2,
      payload: { transaction: 'signed-payload' },
    }),
  );

  it('runs all success hooks with native contexts in payment order', async () => {
    const events: string[] = [];
    const required = vi.fn<PaymentRequiredHook>(async () => {
      events.push('required');
    });
    const before = vi.fn<BeforePaymentCreationHook>(async () => {
      events.push('before');
    });
    const after = vi.fn<AfterPaymentCreationHook>(async () => {
      events.push('after');
    });
    const failure = vi.fn<OnPaymentCreationFailureHook>(async () => undefined);
    const responseHook = vi.fn<OnPaymentResponseHook>(async () => {
      events.push('response');
    });
    const response = paidResponse();
    transport.mockResolvedValueOnce(challenge()).mockResolvedValueOnce(response);
    const paidFetch = createBuyerFetch({
      secret,
      network,
      onPaymentRequired: required,
      onBeforePaymentCreation: before,
      onAfterPaymentCreation: after,
      onPaymentCreationFailure: failure,
      onPaymentResponse: responseHook,
    });
    expect(await paidFetch(url)).toBe(response);
    expect(events).toEqual(['required', 'before', 'after', 'response']);
    expect(required).toHaveBeenCalledExactlyOnceWith({
      paymentRequired: quoted(),
      requestUrl: url,
    });
    expect(before).toHaveBeenCalledExactlyOnceWith({
      paymentRequired: quoted(),
      selectedRequirements: requirement,
    });
    expect(after).toHaveBeenCalledExactlyOnceWith({
      paymentRequired: quoted(),
      selectedRequirements: requirement,
      paymentPayload: createdPayment(),
    });
    expect(responseHook).toHaveBeenCalledExactlyOnceWith({
      paymentPayload: createdPayment(),
      requirements: requirement,
      settleResponse: receipt,
    });
    expect(failure).not.toHaveBeenCalled();
    expect(await response.text()).toBe('forecast');
  });

  it('awaits the after-creation hook before paid transport', async () => {
    const gate = approvalGate();
    const after = vi.fn<AfterPaymentCreationHook>(async () => gate.promise);
    transport.mockResolvedValueOnce(challenge()).mockResolvedValueOnce(paidResponse());
    const paidFetch = createBuyerFetch({ secret, network, onAfterPaymentCreation: after });
    const result = paidFetch(url);
    await vi.waitFor(() => expect(after).toHaveBeenCalledOnce());
    expect(boundary.create).toHaveBeenCalledOnce();
    expect(transport).toHaveBeenCalledOnce();
    gate.approve();
    expect(await (await result).text()).toBe('forecast');
    expect(transport).toHaveBeenCalledTimes(2);
  });

  it('reports scheme/signing failure with the original error and selected terms', async () => {
    const error = new Error('Signature failed');
    boundary.create.mockRejectedValueOnce(error);
    const failure = vi.fn<OnPaymentCreationFailureHook>(async () => undefined);
    const after = vi.fn<AfterPaymentCreationHook>(async () => undefined);
    const responseHook = vi.fn<OnPaymentResponseHook>(async () => undefined);
    transport.mockResolvedValueOnce(challenge());
    const paidFetch = createBuyerFetch({
      secret,
      network,
      onPaymentCreationFailure: failure,
      onAfterPaymentCreation: after,
      onPaymentResponse: responseHook,
    });
    await expect(paidFetch(url)).rejects.toThrow(
      'Failed to create payment payload: Signature failed',
    );
    expect(failure).toHaveBeenCalledExactlyOnceWith({
      paymentRequired: quoted(),
      selectedRequirements: requirement,
      error,
    });
    expect(after).not.toHaveBeenCalled();
    expect(responseHook).not.toHaveBeenCalled();
    expect(transport).toHaveBeenCalledOnce();
  });

  it('permits native creation-failure recovery with the supplied payload', async () => {
    boundary.create.mockRejectedValueOnce(new Error('Signature failed'));
    const payment = { ...createdPayment(), payload: { transaction: 'recovered-payload' } };
    const failure = vi.fn<OnPaymentCreationFailureHook>(async () => ({
      recovered: true,
      payload: payment,
    }));
    transport.mockResolvedValueOnce(challenge()).mockResolvedValueOnce(paidResponse());
    const paidFetch = createBuyerFetch({ secret, network, onPaymentCreationFailure: failure });
    expect(await (await paidFetch(url)).text()).toBe('forecast');
    const request = transport.mock.calls[1]?.[0];
    if (!(request instanceof Request)) throw new Error('Expected Request');
    const header = request.headers.get('PAYMENT-SIGNATURE');
    if (!header) throw new Error('Missing payment signature');
    expect(decodePaymentSignatureHeader(header)).toEqual({
      x402Version: 2,
      resource: quoted().resource,
      accepted: requirement,
      payload: { transaction: 'recovered-payload' },
    });
    expect(boundary.create).toHaveBeenCalledOnce();
    expect(failure).toHaveBeenCalledOnce();
    expect(transport).toHaveBeenCalledTimes(2);
  });

  it('does not treat approval rejection as a native creation failure', async () => {
    const failure = vi.fn<OnPaymentCreationFailureHook>(async () => undefined);
    transport.mockResolvedValueOnce(challenge());
    const paidFetch = createBuyerFetch({
      secret,
      network,
      onPaymentCreationFailure: failure,
      onBeforePaymentCreation: async () => ({ abort: true, reason: 'Declined' }),
    });
    await expect(paidFetch(url)).rejects.toThrow('Payment creation aborted: Declined');
    expect(failure).not.toHaveBeenCalled();
    expect(boundary.create).not.toHaveBeenCalled();
  });

  it('preserves after-hook errors through native creation-failure handling', async () => {
    const error = new Error('After hook failed');
    const failure = vi.fn<OnPaymentCreationFailureHook>(async () => undefined);
    transport.mockResolvedValueOnce(challenge());
    const paidFetch = createBuyerFetch({
      secret,
      network,
      onPaymentCreationFailure: failure,
      onAfterPaymentCreation: async () => {
        throw error;
      },
    });
    await expect(paidFetch(url)).rejects.toThrow(
      'Failed to create payment payload: After hook failed',
    );
    expect(failure).toHaveBeenCalledExactlyOnceWith({
      paymentRequired: quoted(),
      selectedRequirements: requirement,
      error,
    });
    expect(transport).toHaveBeenCalledOnce();
  });

  it('does not invent a receipt for the response hook', async () => {
    const responseHook = vi.fn<OnPaymentResponseHook>(async () => undefined);
    const response = new Response('unconfirmed');
    transport.mockResolvedValueOnce(challenge()).mockResolvedValueOnce(response);
    const paidFetch = createBuyerFetch({ secret, network, onPaymentResponse: responseHook });
    expect(await paidFetch(url)).toBe(response);
    expect(responseHook).toHaveBeenCalledExactlyOnceWith({
      paymentPayload: createdPayment(),
      requirements: requirement,
    });
  });

  it('retains explicit response recovery and asks approval for the fresh payment', async () => {
    const failed = { ...receipt, success: false, errorReason: 'settlement_pending' };
    const responseHook = vi
      .fn<OnPaymentResponseHook>()
      .mockResolvedValueOnce({ recovered: true })
      .mockResolvedValueOnce(undefined);
    const before = vi.fn<BeforePaymentCreationHook>(async () => undefined);
    transport
      .mockResolvedValueOnce(challenge())
      .mockResolvedValueOnce(paidResponse(failed))
      .mockResolvedValueOnce(paidResponse());
    const paidFetch = createBuyerFetch({
      secret,
      network,
      onPaymentResponse: responseHook,
      onBeforePaymentCreation: before,
    });
    expect(await (await paidFetch(url)).text()).toBe('forecast');
    expect(responseHook).toHaveBeenNthCalledWith(1, {
      paymentPayload: createdPayment(),
      requirements: requirement,
      settleResponse: failed,
    });
    expect(responseHook).toHaveBeenNthCalledWith(2, {
      paymentPayload: createdPayment(),
      requirements: requirement,
      settleResponse: receipt,
    });
    expect(before).toHaveBeenCalledTimes(2);
    expect(boundary.create).toHaveBeenCalledTimes(2);
    expect(transport).toHaveBeenCalledTimes(3);
  });

  it('propagates response-hook errors after the paid request without automatic retry', async () => {
    const error = new Error('Result hook failed');
    transport.mockResolvedValueOnce(challenge()).mockResolvedValueOnce(paidResponse());
    const paidFetch = createBuyerFetch({
      secret,
      network,
      onPaymentResponse: async () => {
        throw error;
      },
    });
    await expect(paidFetch(url)).rejects.toBe(error);
    expect(transport).toHaveBeenCalledTimes(2);
    expect(boundary.create).toHaveBeenCalledOnce();
  });

  it('awaits HTTP-required hooks and permits a header retry to avoid payment', async () => {
    const gate = approvalGate();
    const required = vi.fn<PaymentRequiredHook>(async () => {
      await gate.promise;
      return { headers: { 'X-Session': 'existing-access' } };
    });
    const before = vi.fn<BeforePaymentCreationHook>(async () => undefined);
    const responseHook = vi.fn<OnPaymentResponseHook>(async () => undefined);
    const response = new Response('session access');
    transport.mockResolvedValueOnce(challenge()).mockResolvedValueOnce(response);
    const paidFetch = createBuyerFetch({
      secret,
      network,
      onPaymentRequired: required,
      onBeforePaymentCreation: before,
      onPaymentResponse: responseHook,
    });
    const result = paidFetch(url, { headers: { Accept: 'text/plain' } });
    await vi.waitFor(() => expect(required).toHaveBeenCalledOnce());
    expect(transport).toHaveBeenCalledOnce();
    expect(boundary.create).not.toHaveBeenCalled();
    gate.approve();
    expect(await result).toBe(response);
    const request = transport.mock.calls[1]?.[0];
    if (!(request instanceof Request)) throw new Error('Expected Request');
    expect(request.headers.get('X-Session')).toBe('existing-access');
    expect(request.headers.get('Accept')).toBe('text/plain');
    expect(request.headers.get('PAYMENT-SIGNATURE')).toBeNull();
    expect(before).not.toHaveBeenCalled();
    expect(responseHook).not.toHaveBeenCalled();
    expect(boundary.create).not.toHaveBeenCalled();
  });

  it('continues to payment if the HTTP hook header retry still returns 402', async () => {
    const required = vi.fn<PaymentRequiredHook>(async () => ({
      headers: { 'X-Session': 'expired' },
    }));
    const before = vi.fn<BeforePaymentCreationHook>(async () => undefined);
    transport
      .mockResolvedValueOnce(challenge())
      .mockResolvedValueOnce(challenge())
      .mockResolvedValueOnce(paidResponse());
    const paidFetch = createBuyerFetch({
      secret,
      network,
      onPaymentRequired: required,
      onBeforePaymentCreation: before,
    });
    expect(await (await paidFetch(url)).text()).toBe('forecast');
    expect(required).toHaveBeenCalledOnce();
    expect(before).toHaveBeenCalledOnce();
    expect(boundary.create).toHaveBeenCalledOnce();
    expect(transport).toHaveBeenCalledTimes(3);
  });

  it('propagates HTTP hook failure before payment creation', async () => {
    const error = new Error('Session lookup failed');
    const failure = vi.fn<OnPaymentCreationFailureHook>(async () => undefined);
    transport.mockResolvedValueOnce(challenge());
    const paidFetch = createBuyerFetch({
      secret,
      network,
      onPaymentCreationFailure: failure,
      onPaymentRequired: async () => {
        throw error;
      },
    });
    await expect(paidFetch(url)).rejects.toBe(error);
    expect(boundary.create).not.toHaveBeenCalled();
    expect(failure).not.toHaveBeenCalled();
    expect(transport).toHaveBeenCalledOnce();
  });
});

describe('native hook error boundaries', () => {
  it('preserves a failure-hook error instead of adding SDK recovery', async () => {
    boundary.create.mockRejectedValueOnce(new Error('Scheme failed'));
    const failure = vi.fn<OnPaymentCreationFailureHook>(async () => {
      throw new Error('Failure handler failed');
    });
    transport.mockResolvedValueOnce(challenge());
    const paidFetch = createBuyerFetch({ secret, network, onPaymentCreationFailure: failure });
    await expect(paidFetch(url)).rejects.toThrow(
      'Failed to create payment payload: Failure handler failed',
    );
    expect(failure).toHaveBeenCalledOnce();
    expect(transport).toHaveBeenCalledOnce();
  });

  it('leaves a paid transport failure to the caller rather than fabricating hook results', async () => {
    const error = new Error('Paid connection lost');
    const failure = vi.fn<OnPaymentCreationFailureHook>(async () => undefined);
    const responseHook = vi.fn<OnPaymentResponseHook>(async () => undefined);
    transport.mockResolvedValueOnce(challenge()).mockRejectedValueOnce(error);
    const paidFetch = createBuyerFetch({
      secret,
      network,
      onPaymentCreationFailure: failure,
      onPaymentResponse: responseHook,
    });
    await expect(paidFetch(url)).rejects.toBe(error);
    expect(failure).not.toHaveBeenCalled();
    expect(responseHook).not.toHaveBeenCalled();
    expect(boundary.create).toHaveBeenCalledOnce();
    expect(transport).toHaveBeenCalledTimes(2);
  });
});
