import { Address, Keypair, StrKey, hash, nativeToScVal, xdr } from '@stellar/stellar-sdk';
import { getNetworkPassphrase } from '@x402/stellar';
import type * as Stellar from '@x402/stellar';
import type { OnPaymentResponseHook } from '@x402/core/client';
import type { ClientStellarSigner } from '@x402/stellar';
import {
  encodePaymentRequiredHeader,
  encodePaymentResponseHeader,
  decodePaymentSignatureHeader,
} from '@x402/core/http';
import type { PaymentRequired, PaymentRequirements, SettleResponse } from '@x402/core/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEd25519Signer, x402HTTPClient } from '../../src/buyer.js';
import { createPaymentClient } from '../../src/buyer/payment-client.js';
import { wrapFetchWithPayment } from '@x402/fetch';

const boundary = vi.hoisted(() => ({ create: vi.fn(), latest: vi.fn() }));
vi.mock('@x402/stellar', async (importOriginal) => ({
  ...(await importOriginal<typeof Stellar>()),
  getRpcClient: () => ({ getLatestLedger: boundary.latest }),
}));
vi.mock('@x402/stellar/exact/client', () => ({
  ExactStellarScheme: class {
    readonly scheme = 'exact';
    constructor(private readonly signer: ClientStellarSigner) {}
    createPaymentPayload(version: number, requirements: PaymentRequirements) {
      return boundary.create(this.signer, version, requirements);
    }
  },
}));
vi.mock('../../src/schemes/upto/client.js', () => ({
  UptoStellarClient: class {
    readonly scheme = 'upto';
    constructor(private readonly signer: ClientStellarSigner) {}
    createPaymentPayload(version: number, requirements: PaymentRequirements) {
      return boundary.create(this.signer, version, requirements);
    }
  },
}));

const url = 'https://seller.example/weather';
const network = 'stellar:testnet';
const keypair = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 1));
const nativeSigner = createEd25519Signer(keypair.secret(), network);
const asset = StrKey.encodeContract(Buffer.alloc(32, 2));
const payTo = StrKey.encodeEd25519PublicKey(Buffer.alloc(32, 3));
const requirement: PaymentRequirements = {
  scheme: 'exact',
  network,
  asset,
  payTo,
  amount: '40000',
  maxTimeoutSeconds: 60,
  extra: { areFeesSponsored: true },
};
const receipt: SettleResponse = {
  success: true,
  network,
  payer: nativeSigner.address,
  transaction: 'a'.repeat(64),
};
const preimage = xdr.HashIdPreimage.envelopeTypeSorobanAuthorization(
  new xdr.HashIdPreimageSorobanAuthorization({
    networkId: hash(Buffer.from(getNetworkPassphrase(network))),
    nonce: xdr.Int64.fromString('42'),
    signatureExpirationLedger: 112,
    invocation: new xdr.SorobanAuthorizedInvocation({
      function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
        new xdr.InvokeContractArgs({
          contractAddress: Address.fromString(asset).toScAddress(),
          functionName: 'transfer',
          args: [
            nativeToScVal(nativeSigner.address, { type: 'address' }),
            nativeToScVal(payTo, { type: 'address' }),
            nativeToScVal('40000', { type: 'i128' }),
          ],
        }),
      ),
      subInvocations: [],
    }),
  }),
).toXDR('base64');
function challenge(accepted = requirement): Response {
  const quote: PaymentRequired = {
    x402Version: 2,
    resource: { url, description: 'Weather', mimeType: 'application/json' },
    accepts: [accepted],
  };
  return new Response('unpaid', {
    status: 402,
    headers: { 'PAYMENT-REQUIRED': encodePaymentRequiredHeader(quote) },
  });
}
function settled(status = 200): Response {
  return new Response('{"forecast":"sunny"}', {
    status,
    headers: { 'PAYMENT-RESPONSE': encodePaymentResponseHeader(receipt) },
  });
}
let transport: ReturnType<typeof vi.fn<typeof fetch>>;
let signer: typeof nativeSigner;
let client: ReturnType<typeof createPaymentClient>;
let paidFetch: ReturnType<typeof wrapFetchWithPayment>;
function sent(index: number): Request {
  const request = transport.mock.calls[index]?.[0];
  if (!(request instanceof Request)) throw new Error('Expected a native Request');
  return request;
}

beforeEach(() => {
  vi.resetAllMocks();
  transport = vi.fn<typeof fetch>();
  vi.stubGlobal('fetch', transport);
  signer = {
    ...nativeSigner,
    signAuthEntry: vi.fn(nativeSigner.signAuthEntry),
    signTransaction: vi.fn(nativeSigner.signTransaction),
  };
  client = createPaymentClient({ network, signer });
  paidFetch = wrapFetchWithPayment(fetch, client);
  boundary.latest.mockResolvedValue({ sequence: 100 });
  boundary.create.mockImplementation(async (identity: ClientStellarSigner, version: number) => {
    await identity.signAuthEntry(preimage, { address: identity.address });
    return { x402Version: version, payload: { transaction: 'signed-transaction-xdr' } };
  });
});
afterEach(() => vi.unstubAllGlobals());

describe('native x402 paid fetch integration', () => {
  it.each([200, 302, 404, 500])(
    'returns an ordinary %s response unchanged and unread',
    async (status) => {
      const response = new Response('ordinary', { status });
      transport.mockResolvedValue(response);
      expect(await paidFetch(url)).toBe(response);
      expect(await response.text()).toBe('ordinary');
      expect(transport).toHaveBeenCalledOnce();
      expect(signer.signAuthEntry).not.toHaveBeenCalled();
    },
  );

  it.each(['exact', 'upto'])(
    'pays %s with the existing policy, approval, signer and response hooks',
    async (scheme) => {
      const accepted = { ...requirement, scheme };
      const response = settled();
      transport.mockResolvedValueOnce(challenge(accepted)).mockResolvedValueOnce(response);
      const events: string[] = [];
      const policy = vi.fn((_version, requirements: PaymentRequirements[]) => requirements);
      client.registerPolicy(policy);
      client.onBeforePaymentCreation(async () => {
        events.push('before');
      });
      client.onAfterPaymentCreation(async () => {
        events.push('after');
      });
      client.onPaymentResponse(async () => {
        events.push('response');
      });
      expect(await paidFetch(url)).toBe(response);
      expect(await response.json()).toEqual({ forecast: 'sunny' });
      expect(policy).toHaveBeenCalledExactlyOnceWith(2, [accepted]);
      expect(events).toEqual(['before', 'after', 'response']);
      expect(transport).toHaveBeenCalledTimes(2);
      expect(sent(0).url).toBe(url);
      expect(sent(0).headers.get('PAYMENT-SIGNATURE')).toBeNull();
      const header = sent(1).headers.get('PAYMENT-SIGNATURE');
      if (!header) throw new Error('Missing payment signature');
      expect(decodePaymentSignatureHeader(header)).toEqual({
        x402Version: 2,
        accepted,
        resource: { url, description: 'Weather', mimeType: 'application/json' },
        payload: { transaction: 'signed-transaction-xdr' },
      });
      expect(signer.signAuthEntry).toHaveBeenCalledExactlyOnceWith(preimage, {
        address: signer.address,
      });
      expect(signer.signTransaction).not.toHaveBeenCalled();
    },
  );

  it('uses the upstream parsing error for a 402 without payment requirements', async () => {
    transport.mockResolvedValue(new Response('payment needed elsewhere', { status: 402 }));
    await expect(paidFetch(url)).rejects.toThrow('Failed to parse payment requirements:');
    expect(transport).toHaveBeenCalledOnce();
    expect(signer.signAuthEntry).not.toHaveBeenCalled();
  });

  it('returns a changed second 402 without authorizing another amount', async () => {
    const second = challenge({ ...requirement, amount: '80000' });
    transport.mockResolvedValueOnce(challenge()).mockResolvedValueOnce(second);
    expect(await paidFetch(url)).toBe(second);
    expect(await second.text()).toBe('unpaid');
    expect(transport).toHaveBeenCalledTimes(2);
    expect(boundary.create).toHaveBeenCalledOnce();
    expect(signer.signAuthEntry).toHaveBeenCalledOnce();
  });

  it('follows native explicit recovery with a fresh payload and one additional paid request', async () => {
    const response = settled();
    transport
      .mockResolvedValueOnce(challenge())
      .mockResolvedValueOnce(settled(503))
      .mockResolvedValueOnce(response);
    const hook = vi
      .fn<OnPaymentResponseHook>()
      .mockResolvedValueOnce({ recovered: true })
      .mockResolvedValueOnce(undefined);
    client.onPaymentResponse(hook);
    let attempt = 0;
    boundary.create.mockImplementation(async (identity: ClientStellarSigner, version: number) => {
      await identity.signAuthEntry(preimage, { address: identity.address });
      return { x402Version: version, payload: { transaction: `signed-${++attempt}` } };
    });
    expect(await paidFetch(url)).toBe(response);
    expect(transport).toHaveBeenCalledTimes(3);
    expect(signer.signAuthEntry).toHaveBeenCalledTimes(2);
    expect(hook).toHaveBeenCalledTimes(2);
    for (const index of [1, 2]) {
      const header = sent(index).headers.get('PAYMENT-SIGNATURE');
      if (!header) throw new Error('Missing payment signature');
      expect(decodePaymentSignatureHeader(header).payload).toEqual({
        transaction: `signed-${index}`,
      });
    }
  });

  it('runs HTTP payment-required hooks before authorizing a payment', async () => {
    const http = new x402HTTPClient(client);
    const hook = vi.fn(async () => ({ headers: { 'X-Session': 'existing-access' } }));
    http.onPaymentRequired(hook);
    const wrapped = wrapFetchWithPayment(fetch, http);
    const response = new Response('already authorized');
    transport.mockResolvedValueOnce(challenge()).mockResolvedValueOnce(response);
    expect(await wrapped(url)).toBe(response);
    expect(hook).toHaveBeenCalledExactlyOnceWith({
      paymentRequired: {
        x402Version: 2,
        resource: { url, description: 'Weather', mimeType: 'application/json' },
        accepts: [requirement],
      },
      requestUrl: url,
    });
    expect(sent(1).headers.get('X-Session')).toBe('existing-access');
    expect(transport).toHaveBeenCalledTimes(2);
    expect(signer.signAuthEntry).not.toHaveBeenCalled();
  });

  it('does not invent a receipt for a successful HTTP response without one', async () => {
    const response = new Response('resource', { status: 200 });
    transport.mockResolvedValueOnce(challenge()).mockResolvedValueOnce(response);
    const hook = vi.fn<OnPaymentResponseHook>(async () => undefined);
    client.onPaymentResponse(hook);
    expect(await paidFetch(url)).toBe(response);
    expect(response.headers.get('PAYMENT-RESPONSE')).toBeNull();
    expect(hook.mock.calls[0]?.[0].settleResponse).toBeUndefined();
  });

  it('applies policy rejection before RPC and signing', async () => {
    client.registerPolicy(() => []);
    transport.mockResolvedValue(challenge());
    await expect(paidFetch(url)).rejects.toThrow(
      'All payment requirements were filtered out by policies for x402 version: 2',
    );
    expect(transport).toHaveBeenCalledOnce();
    expect(boundary.create).not.toHaveBeenCalled();
    expect(signer.signAuthEntry).not.toHaveBeenCalled();
  });

  it('honors the configured approval hook before preparing authorization', async () => {
    client.onBeforePaymentCreation(async () => ({ abort: true, reason: 'Approval declined' }));
    transport.mockResolvedValue(challenge());
    await expect(paidFetch(url)).rejects.toThrow('Payment creation aborted: Approval declined');
    expect(transport).toHaveBeenCalledOnce();
    expect(boundary.create).not.toHaveBeenCalled();
  });

  it('rejects unsupported networks without asking for a signature', async () => {
    transport.mockResolvedValue(challenge({ ...requirement, network: 'stellar:pubnet' }));
    await expect(paidFetch(url)).rejects.toThrow(/No network\/scheme registered/);
    expect(signer.signAuthEntry).not.toHaveBeenCalled();
    expect(transport).toHaveBeenCalledOnce();
  });

  it('rejects malformed challenges before signing', async () => {
    transport.mockResolvedValue(
      new Response('unpaid', { status: 402, headers: { 'PAYMENT-REQUIRED': 'not-json' } }),
    );
    await expect(paidFetch(url)).rejects.toThrow(Error);
    expect(signer.signAuthEntry).not.toHaveBeenCalled();
    expect(transport).toHaveBeenCalledOnce();
  });

  it.each(['PAYMENT-SIGNATURE', 'x-payment'])(
    'accepts caller-supplied %s on a successful request',
    async (header) => {
      const response = new Response('already paid');
      transport.mockResolvedValue(response);
      expect(await paidFetch(url, { headers: { [header]: 'external-payment' } })).toBe(response);
      expect(sent(0).headers.get(header)).toBe('external-payment');
      expect(transport).toHaveBeenCalledOnce();
      expect(signer.signAuthEntry).not.toHaveBeenCalled();
    },
  );

  it.each(['follow', 'error', 'manual'] as const)(
    'preserves native redirect mode %s on both sends',
    async (redirect) => {
      transport.mockResolvedValueOnce(challenge()).mockResolvedValueOnce(settled());
      await paidFetch(url, { redirect });
      expect([sent(0).redirect, sent(1).redirect]).toEqual([redirect, redirect]);
    },
  );

  it('accepts a Request with native init overrides and preserves its body', async () => {
    const request = new Request(url, {
      method: 'POST',
      body: 'original',
      headers: { 'X-Trace': 'inherited' },
      credentials: 'include',
      redirect: 'manual',
    });
    transport.mockResolvedValueOnce(challenge()).mockResolvedValueOnce(settled());
    await paidFetch(request, {
      method: 'PUT',
      headers: { 'X-Trace': 'override' },
      redirect: 'error',
    });
    for (const actual of [sent(0), sent(1)]) {
      expect(actual.url).toBe(url);
      expect(actual.method).toBe('PUT');
      expect(actual.headers.get('X-Trace')).toBe('override');
      expect(actual.credentials).toBe('include');
      expect(actual.redirect).toBe('error');
      expect(await actual.text()).toBe('original');
    }
  });

  it('replays multipart fields and files with exactly the same boundary and bytes', async () => {
    const form = new FormData();
    form.set('city', 'Shanghai');
    form.set('attachment', new Blob(['forecast data'], { type: 'text/plain' }), 'forecast.txt');
    transport
      .mockImplementationOnce(async () => {
        form.set('city', 'changed');
        return challenge();
      })
      .mockResolvedValueOnce(settled());
    await paidFetch(url, { method: 'POST', body: form });
    const first = sent(0);
    const second = sent(1);
    const multipart = await second.clone().formData();
    expect(multipart.get('city')).toBe('Shanghai');
    const file = multipart.get('attachment');
    if (!(file instanceof File)) throw new Error('Expected attachment');
    expect(file.name).toBe('forecast.txt');
    expect(file.type).toBe('text/plain');
    expect(await file.text()).toBe('forecast data');
    expect(second.headers.get('Content-Type')).toBe(first.headers.get('Content-Type'));
    expect(await second.text()).toBe(await first.text());
  });

  it('replays a native stream after transport consumes the initial request', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('streamed forecast'));
        controller.close();
      },
    });
    const init = { method: 'POST', body: stream, duplex: 'half' };
    transport
      .mockImplementationOnce(async (input) => {
        if (!(input instanceof Request)) throw new Error('Expected Request');
        expect(await input.text()).toBe('streamed forecast');
        return challenge();
      })
      .mockImplementationOnce(async (input) => {
        if (!(input instanceof Request)) throw new Error('Expected Request');
        expect(await input.text()).toBe('streamed forecast');
        return settled();
      });
    expect((await paidFetch(url, init)).status).toBe(200);
    expect(transport).toHaveBeenCalledTimes(2);
  });

  it.each(['used', 'locked'] as const)(
    'rejects a %s Request body before transport',
    async (state) => {
      const request = new Request(url, { method: 'POST', body: 'forecast' });
      const reader = state === 'locked' ? request.body?.getReader() : undefined;
      if (state === 'used') await request.text();
      try {
        await expect(paidFetch(request)).rejects.toThrow(TypeError);
        expect(transport).not.toHaveBeenCalled();
        expect(signer.signAuthEntry).not.toHaveBeenCalled();
      } finally {
        reader?.releaseLock();
      }
    },
  );

  it('preserves a native stream read failure before signing', async () => {
    const reason = new Error('Input stream failed');
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(reason);
      },
    });
    const init = { method: 'POST', body: stream, duplex: 'half' };
    transport.mockImplementation(async (input) => {
      if (!(input instanceof Request)) throw new Error('Expected Request');
      await input.text();
      return challenge();
    });
    await expect(paidFetch(url, init)).rejects.toBe(reason);
    expect(transport).toHaveBeenCalledOnce();
    expect(signer.signAuthEntry).not.toHaveBeenCalled();
  });

  it('replays a body larger than 1 MiB without an SDK buffer cap', async () => {
    const body = '你好'.repeat(200000);
    transport.mockResolvedValueOnce(challenge()).mockResolvedValueOnce(settled());
    await paidFetch(url, { method: 'POST', body });
    expect(await sent(0).text()).toBe(body);
    expect(await sent(1).text()).toBe(body);
  });

  it.each([
    { body: 'hello', expected: 'hello' },
    { body: new URLSearchParams({ city: 'New York' }), expected: 'city=New+York' },
    { body: Uint8Array.of(65, 66).buffer, expected: 'AB' },
    { body: Uint8Array.of(65, 66), expected: 'AB' },
    { body: new DataView(Uint8Array.of(0, 65, 66, 0).buffer, 1, 2), expected: 'AB' },
    { body: new Blob(['hello'], { type: 'text/plain' }), expected: 'hello' },
  ])('replays the same bytes for $expected', async ({ body, expected }) => {
    transport.mockResolvedValueOnce(challenge()).mockResolvedValueOnce(settled());
    await paidFetch(url, { method: 'POST', body });
    expect(await sent(0).text()).toBe(expected);
    expect(await sent(1).text()).toBe(expected);
    expect(sent(1).headers.get('Content-Type')).toBe(sent(0).headers.get('Content-Type'));
  });

  it('snapshots mutable URL, bytes and headers before transport', async () => {
    const target = new URL(url);
    const body = Uint8Array.of(65, 66);
    const headers = new Headers({ Accept: 'application/json', 'X-Trace': 'original' });
    transport
      .mockImplementationOnce(async () => {
        target.pathname = '/other';
        body.fill(90);
        headers.set('X-Trace', 'changed');
        return challenge();
      })
      .mockResolvedValueOnce(settled());
    await paidFetch(target, {
      method: 'POST',
      headers,
      body,
      credentials: 'include',
      cache: 'no-store',
    });
    for (const request of [sent(0), sent(1)]) {
      expect(request.url).toBe(url);
      expect(request.method).toBe('POST');
      expect(request.headers.get('Accept')).toBe('application/json');
      expect(request.headers.get('X-Trace')).toBe('original');
      expect(request.credentials).toBe('include');
      expect(request.cache).toBe('no-store');
      expect(request.redirect).toBe('follow');
      expect(await request.text()).toBe('AB');
    }
  });

  it('forwards an aborted signal to native transport without a different SDK error', async () => {
    const reason = new Error('Caller cancelled');
    transport.mockImplementation(async (input) => {
      if (!(input instanceof Request)) throw new Error('Expected Request');
      expect(input.signal.reason).toBe(reason);
      input.signal.throwIfAborted();
      return settled();
    });
    await expect(paidFetch(url, { signal: AbortSignal.abort(reason) })).rejects.toBe(reason);
    expect(transport).toHaveBeenCalledOnce();
    expect(signer.signAuthEntry).not.toHaveBeenCalled();
  });

  it('preserves the underlying transport error after a paid request', async () => {
    const cause = new Error('Connection lost after payment submission');
    transport.mockResolvedValueOnce(challenge()).mockRejectedValueOnce(cause);
    await expect(paidFetch(url)).rejects.toBe(cause);
    expect(transport).toHaveBeenCalledTimes(2);
    expect(signer.signAuthEntry).toHaveBeenCalledOnce();
  });

  it('preserves errors from native result hooks', async () => {
    const cause = new Error('Receipt callback failed');
    transport.mockResolvedValueOnce(challenge()).mockResolvedValueOnce(settled());
    client.onPaymentResponse(async () => {
      throw cause;
    });
    await expect(paidFetch(url)).rejects.toBe(cause);
    expect(transport).toHaveBeenCalledTimes(2);
  });

  it('preserves the initial transport error without signing', async () => {
    const cause = new Error('Initial connection failed');
    transport.mockRejectedValue(cause);
    await expect(paidFetch(url)).rejects.toBe(cause);
    expect(transport).toHaveBeenCalledOnce();
    expect(signer.signAuthEntry).not.toHaveBeenCalled();
  });

  it('keeps the original transport if the caller installs paidFetch globally', async () => {
    transport.mockResolvedValueOnce(challenge()).mockResolvedValueOnce(settled());
    vi.stubGlobal('fetch', paidFetch);
    expect((await paidFetch(url)).status).toBe(200);
    expect(transport).toHaveBeenCalledTimes(2);
    expect(signer.signAuthEntry).toHaveBeenCalledOnce();
  });
});
