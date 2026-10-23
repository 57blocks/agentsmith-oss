import type { PaymentPayload, PaymentRequirements, SettleResponse } from '@x402/core/types';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { FacilitatorConfig } from '../src/config/facilitator.config.js';
import { BazaarReporter } from '../src/modules/x402/services/bazaar/bazaar-reporter.js';

const ENDPOINT = 'http://127.0.0.1:8402/discovery/settlements';
const RESOURCE = 'https://agentsmith.xyz/metar/v1/metar';

const requirements = {
  scheme: 'exact',
  network: 'stellar:testnet',
  asset: 'C_USDC',
  payTo: 'G_PAY_TO',
  amount: '10000',
  maxTimeoutSeconds: 60,
  extra: {},
} as PaymentRequirements;
const payload = {
  x402Version: 2,
  accepted: requirements,
  payload: {},
  resource: { url: RESOURCE },
} as PaymentPayload;
const settled: SettleResponse = {
  success: true,
  transaction: 'abc123',
  network: 'stellar:testnet',
  payer: 'G_PAYER',
};

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
let fetchMock: Mock<typeof fetch>;

beforeEach(() => {
  fetchMock = vi.fn<typeof fetch>(async () => new Response('{}', { status: 201 }));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.clearAllMocks();
});

function reporter(
  config: Pick<FacilitatorConfig, 'bazaarSettlementUrl'> = { bazaarSettlementUrl: ENDPOINT },
): BazaarReporter {
  return new BazaarReporter(config as FacilitatorConfig, log);
}

describe('Bazaar settlement report', () => {
  it('posts a successful settlement with its transaction, resource and payer', async () => {
    await reporter().report(payload, requirements, settled);

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(ENDPOINT);
    expect(JSON.parse(String(init?.body))).toEqual({
      transaction: 'abc123',
      resource_url: RESOURCE,
      network: 'stellar:testnet',
      payer: 'G_PAYER',
    });
    expect(log.info).toHaveBeenCalledWith('settlement_reported', {
      transaction: 'abc123',
      resource_url: RESOURCE,
    });
  });

  it('reports nothing for a failed settlement', async () => {
    const failed: SettleResponse = {
      success: false,
      errorReason: 'invalid_transaction_state',
      transaction: 'abc123',
      network: 'stellar:testnet',
    };

    await reporter().report(payload, requirements, failed);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reports nothing for a success with no transaction, such as a zero settlement', async () => {
    await reporter().report(payload, requirements, { ...settled, transaction: '', amount: '0' });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reports nothing when no Bazaar endpoint is configured', async () => {
    await reporter({ bazaarSettlementUrl: undefined }).report(payload, requirements, settled);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('skips a settlement without a resource URL and logs why', async () => {
    const withoutResource = { ...payload, resource: undefined } as PaymentPayload;

    await reporter().report(withoutResource, requirements, settled);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith('settlement_report_skipped', {
      reason: 'resource_url_missing',
      transaction: 'abc123',
    });
  });

  it('resolves and logs the status when Bazaar refuses the report', async () => {
    fetchMock.mockResolvedValueOnce(new Response('{}', { status: 503 }));

    await expect(reporter().report(payload, requirements, settled)).resolves.toBeUndefined();

    expect(log.warn).toHaveBeenCalledWith('settlement_report_failed', {
      status: 503,
      transaction: 'abc123',
    });
  });

  it('resolves and logs the error name when Bazaar cannot be reached', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'));

    await expect(reporter().report(payload, requirements, settled)).resolves.toBeUndefined();

    expect(log.warn).toHaveBeenCalledWith('settlement_report_failed', {
      transaction: 'abc123',
      errorName: 'TypeError',
    });
  });

  it('gives up after two seconds when Bazaar does not answer', async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementationOnce(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
        }),
    );

    const report = reporter().report(payload, requirements, settled);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(log.warn).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    await expect(report).resolves.toBeUndefined();
    expect(log.warn).toHaveBeenCalledWith('settlement_report_failed', {
      transaction: 'abc123',
      errorName: 'AbortError',
    });
  });
});
