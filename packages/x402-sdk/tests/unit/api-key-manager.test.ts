import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiKeyManager, ApiKeyOutcomeUnknownError, ApiKeyRequestError } from '../../src/seller.js';

const URL_BASE = 'https://facilitator.example.com/facilitator';
const KEY = 'fsk_current-key-value';
const NEW_KEY = 'fsk_new-key-value';
const registration = { name: 'Weather', domain: 'weather.example.com', email: 'ops@example.com' };

function stubFetch(...responses: (Response | Error)[]) {
  const fetcher = vi.fn<typeof fetch>();
  for (const response of responses) {
    if (response instanceof Error) fetcher.mockRejectedValueOnce(response);
    else fetcher.mockResolvedValueOnce(response);
  }
  vi.stubGlobal('fetch', fetcher);
  return fetcher;
}

function errorBody(status: number, code: string, headers?: HeadersInit) {
  return Response.json(
    { error: { code, message: `upstream text with ${KEY} and ${registration.email}` } },
    { status, headers },
  );
}

const manager = () => new ApiKeyManager({ facilitatorUrl: `${URL_BASE}/` });

/** Every key request, with a call that sends it. */
const operations = [
  { operation: 'create', call: () => manager().createApiKey(registration) },
  { operation: 'rotate', call: () => manager().rotateApiKey(KEY) },
  { operation: 'revoke', call: () => manager().revokeApiKey(KEY) },
] as const;

async function caught(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => expect.unreachable('expected a rejection'),
    (error: unknown) => error,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ApiKeyManager requests', () => {
  it('sends nothing when constructed', () => {
    const fetcher = stubFetch();
    manager();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each(['not a url', 'ftp://example.com', 'https://user:pw@example.com', 'https://x.com?a=1'])(
    'rejects the Facilitator URL %s',
    (facilitatorUrl) => {
      expect(() => new ApiKeyManager({ facilitatorUrl })).toThrow(TypeError);
    },
  );

  it.each([0, -1, 1.5, NaN])('rejects the timeout %s', (timeoutMs) => {
    expect(() => new ApiKeyManager({ facilitatorUrl: URL_BASE, timeoutMs })).toThrow(TypeError);
  });

  it('creates a key by registering without credentials', async () => {
    const fetcher = stubFetch(
      Response.json({ resourceServerId: 'id-1', apiKey: NEW_KEY }, { status: 201 }),
    );
    await expect(manager().createApiKey(registration)).resolves.toEqual({ apiKey: NEW_KEY });
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe(`${URL_BASE}/credentials/register`);
    expect(init?.method).toBe('POST');
    const headers = new Headers(init?.headers);
    expect(headers.get('Authorization')).toBeNull();
    expect(headers.get('Content-Type')).toBe('application/json');
    expect(JSON.parse(init?.body as string)).toEqual(registration);
  });

  it('rotates with the presented key as the Bearer credential', async () => {
    const fetcher = stubFetch(Response.json({ apiKey: NEW_KEY }, { status: 201 }));
    await expect(manager().rotateApiKey(KEY)).resolves.toEqual({ apiKey: NEW_KEY });
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe(`${URL_BASE}/credentials/keys/rotate`);
    expect(init?.method).toBe('POST');
    expect(new Headers(init?.headers).get('Authorization')).toBe(`Bearer ${KEY}`);
  });

  it('revokes the presented key', async () => {
    const fetcher = stubFetch(new Response(null, { status: 204 }));
    await expect(manager().revokeApiKey(KEY)).resolves.toBeUndefined();
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe(`${URL_BASE}/credentials/keys/current`);
    expect(init?.method).toBe('DELETE');
    expect(new Headers(init?.headers).get('Authorization')).toBe(`Bearer ${KEY}`);
  });

  it('bounds each request with the configured timeout', async () => {
    const fetcher = stubFetch(new Response(null, { status: 204 }));
    await new ApiKeyManager({ facilitatorUrl: URL_BASE, timeoutMs: 1_000 }).revokeApiKey(KEY);
    expect(fetcher.mock.calls[0]![1]?.signal).toBeInstanceOf(AbortSignal);
  });

  it.each(['', ' ', 'key\nheader'])('rejects the key %j before sending', async (apiKey) => {
    const fetcher = stubFetch();
    await expect(manager().rotateApiKey(apiKey)).rejects.toThrow(TypeError);
    await expect(manager().revokeApiKey(apiKey)).rejects.toThrow(TypeError);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    { field: 'name', value: 1 },
    { field: 'domain', value: null },
    { field: 'email', value: undefined },
  ])('rejects a non-string $field before sending', async ({ field, value }) => {
    const fetcher = stubFetch();
    const input = { ...registration, [field]: value } as unknown as typeof registration;
    await expect(manager().createApiKey(input)).rejects.toThrow(TypeError);
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe('ApiKeyManager refusals', () => {
  it.each([
    { status: 400, code: 'INVALID_REQUEST' },
    { status: 409, code: 'DOMAIN_TAKEN' },
  ])('reports a $status $code registration refusal', async ({ status, code }) => {
    stubFetch(errorBody(status, code));
    const error = await caught(manager().createApiKey(registration));
    expect(error).toBeInstanceOf(ApiKeyRequestError);
    expect(error).toMatchObject({ operation: 'create', status, code });
  });

  it.each([
    { status: 401, code: 'UNAUTHORIZED' },
    { status: 409, code: 'NOT_CURRENT_KEY' },
    { status: 503, code: 'CREDENTIAL_STORE_UNAVAILABLE' },
  ])('reports a $status $code rotation refusal', async ({ status, code }) => {
    stubFetch(errorBody(status, code));
    await expect(manager().rotateApiKey(KEY)).rejects.toMatchObject({
      operation: 'rotate',
      status,
      code,
    });
  });

  it('reports the rate limit with its retry delay', async () => {
    stubFetch(errorBody(429, 'RATE_LIMITED', { 'Retry-After': '120' }));
    await expect(manager().createApiKey(registration)).rejects.toMatchObject({
      status: 429,
      code: 'RATE_LIMITED',
      retryAfterSeconds: 120,
    });
  });

  it('reports a 4xx without a Facilitator error body without a code', async () => {
    stubFetch(new Response('Not Found', { status: 404 }));
    const error = await caught(manager().revokeApiKey(KEY));
    expect(error).toBeInstanceOf(ApiKeyRequestError);
    expect(error).toMatchObject({ status: 404, code: undefined });
  });

  it.each(operations)(
    'keeps keys, email and upstream text out of a $operation error',
    async ({ call }) => {
      stubFetch(errorBody(409, 'DOMAIN_TAKEN'));
      const error = await caught(call());
      const visible = JSON.stringify(error) + String(error) + (error as Error).stack;
      for (const secret of [KEY, registration.email, 'upstream text']) {
        expect(visible).not.toContain(secret);
      }
    },
  );
});

describe('ApiKeyManager uncertain outcomes', () => {
  it.each(operations)(
    'reports a $operation timeout as unknown after one request',
    async ({ operation, call }) => {
      const fetcher = stubFetch(new DOMException('The operation timed out.', 'TimeoutError'));
      const error = await caught(call());
      expect(error).toBeInstanceOf(ApiKeyOutcomeUnknownError);
      expect(error).toMatchObject({ operation });
      expect(fetcher).toHaveBeenCalledOnce();
    },
  );

  it('reports a network failure as unknown', async () => {
    stubFetch(new TypeError('fetch failed', { cause: new Error(`connect ${KEY}`) }));
    const error = await caught(manager().createApiKey(registration));
    expect(error).toBeInstanceOf(ApiKeyOutcomeUnknownError);
    expect(JSON.stringify(error) + String(error)).not.toContain(KEY);
  });

  it('reports a gateway error without a Facilitator body as unknown', async () => {
    stubFetch(new Response('<html>504</html>', { status: 504 }));
    await expect(manager().rotateApiKey(KEY)).rejects.toBeInstanceOf(ApiKeyOutcomeUnknownError);
  });

  it.each([
    Response.json({ resourceServerId: 'id-1' }, { status: 201 }),
    Response.json({ apiKey: '' }, { status: 201 }),
    new Response('not json', { status: 201 }),
  ])('reports a success without a usable key as unknown', async (response) => {
    stubFetch(response);
    await expect(manager().createApiKey(registration)).rejects.toBeInstanceOf(
      ApiKeyOutcomeUnknownError,
    );
  });
});
