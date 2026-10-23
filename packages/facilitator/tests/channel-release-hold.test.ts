import { describe, expect, it } from 'vitest';
import { releaseHoldMs } from '../src/modules/channels/core/channel-pool.js';

const policy = { cooldownMs: 6_000, unknownMarginMs: 30_000 };
const now = 1_000_000;

describe('how long a channel stays leased after a settlement', () => {
  it('frees a channel at once when nothing was sent', () => {
    expect(releaseHoldMs({ kind: 'not-sent' }, policy, now)).toBe(0);
  });

  it('cools a channel down after an RPC rejection', () => {
    expect(releaseHoldMs({ kind: 'rejected', status: 'ERROR' }, policy, now)).toBe(6_000);
  });

  it('cools a channel down after a transaction is included, successful or not', () => {
    expect(releaseHoldMs({ kind: 'included', hash: 'h', successful: true }, policy, now)).toBe(
      6_000,
    );
    expect(releaseHoldMs({ kind: 'included', hash: 'h', successful: false }, policy, now)).toBe(
      6_000,
    );
  });

  it('holds a channel with an unknown outcome until its transaction expires, plus the margin', () => {
    const outcome = { kind: 'unknown' as const, hash: 'h', validUntilMs: now + 300_000 };
    expect(releaseHoldMs(outcome, policy, now)).toBe(330_000);
  });

  it('still holds for the margin when the validity window has already passed', () => {
    const outcome = { kind: 'unknown' as const, validUntilMs: now - 5_000 };
    expect(releaseHoldMs(outcome, policy, now)).toBe(30_000);
  });
});
