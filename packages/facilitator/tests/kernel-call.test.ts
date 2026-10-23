import type { PaymentRequirements } from '@x402/core/types';
import { describe, expect, it } from 'vitest';
import { samePayment } from '../src/modules/x402/services/schemes/upto/kernel-call.js';

const accepted = {
  scheme: 'upto',
  network: 'stellar:testnet',
  amount: '10000',
  asset: 'C_TOKEN',
  payTo: 'G_PAYEE',
  maxTimeoutSeconds: 60,
  extra: { settlementContract: 'C_KERNEL', facilitator: 'G_FACILITATOR' },
} as PaymentRequirements;

describe('upto payment terms', () => {
  it('treats a lower actual amount under the same terms as the accepted payment', () => {
    expect(samePayment(accepted, { ...accepted, amount: '400' })).toBe(true);
  });

  it.each([
    ['recipient', { payTo: 'G_OTHER' }],
    ['asset', { asset: 'C_OTHER' }],
    ['timeout', { maxTimeoutSeconds: 30 }],
    ['Kernel contract', { extra: { ...accepted.extra, settlementContract: 'C_OTHER' } }],
    ['scheme', { scheme: 'exact' }],
  ])('rejects settlement terms with a different %s', (_, change) => {
    expect(samePayment(accepted, { ...accepted, ...change } as PaymentRequirements)).toBe(false);
  });
});
