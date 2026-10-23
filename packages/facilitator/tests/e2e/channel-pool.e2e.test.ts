import type { PaymentPayload, PaymentRequirements } from '@x402/core/types';
import { describe, expect, it } from 'vitest';
import {
  call,
  e2eEnv,
  exactPayload,
  fundedAccount,
  kindOf,
  nativeBalance,
  recordSettlement,
  requirementsFor,
  settledBalance,
  sleep,
  x402Body,
  type HttpResult,
} from './e2e-support.js';

const AMOUNT = 100_000n;
const UNAVAILABLE = 'settle_exact_stellar_channel_unavailable';
/** Longer than the channel cooldown (6 s) plus a ledger, so released channels are free again. */
const RETRY_AFTER_MS = 15_000;

interface Payment {
  payload: PaymentPayload;
  terms: PaymentRequirements;
}

const settle = ({ payload, terms }: Payment) => call('/settle', x402Body(payload, terms));

const isSettled = (result: HttpResult) => result.body.success === true;

/** Resends busy payments a pool's worth at a time, each batch after the previous one's cooldown. */
async function retryInBatches(busy: Payment[], channelCount: number): Promise<HttpResult[]> {
  const results: HttpResult[] = [];
  for (let start = 0; start < busy.length; start += channelCount) {
    await sleep(RETRY_AFTER_MS);
    results.push(...(await Promise.all(busy.slice(start, start + channelCount).map(settle))));
  }
  return results;
}

describe('deployed channel pool', () => {
  // A valid settlement holds its channel until confirmation plus the 6 s cooldown, longer than the
  // 3 s acquire wait, so exactly one settlement per channel gets through and the rest are busy.
  it.skip('settles one payment per channel, answers the rest as busy, and settles them on retry', async () => {
    const { channelCount } = e2eEnv();
    const [buyer, payTo] = await Promise.all([fundedAccount(), fundedAccount()]);
    const kind = await kindOf('exact');
    // A long timeout keeps every authorization valid across the retry rounds.
    const terms = requirementsFor(kind, {
      payTo: payTo.publicKey(),
      amount: AMOUNT.toString(),
      maxTimeoutSeconds: 300,
    });
    const payments = await Promise.all(
      Array.from({ length: channelCount * 3 }, async () => ({
        payload: await exactPayload(buyer, terms),
        terms,
      })),
    );
    const before = await nativeBalance(payTo.publicKey());

    const first = await Promise.all(payments.map(settle));
    const settled = first.filter(isSettled);
    const busy = payments.filter((_, i) => !isSettled(first[i]!));
    // Other counts mean E2E_CHANNEL_COUNT differs from develop's pool, or others were settling.
    expect(settled).toHaveLength(channelCount);
    expect(busy).toHaveLength(payments.length - channelCount);
    for (const result of first.filter((r) => !isSettled(r))) {
      expect(result.body).toMatchObject({ success: false, errorReason: UNAVAILABLE });
    }

    const retried = await retryInBatches(busy, channelCount);
    expect(retried.map((result) => result.body.success)).toEqual(busy.map(() => true));
    [...settled, ...retried].forEach((result, i) => recordSettlement(`pool ${i + 1}`, result.body));
    const expected = before + AMOUNT * BigInt(payments.length);
    expect(await settledBalance(payTo.publicKey(), expected)).toBe(expected);
  }, 300_000);
});
