import type { Redis } from 'ioredis';

/** Counts hits per key in fixed windows; shared by every instance when backed by Valkey. */
export interface RateLimitStore {
  /** Records one hit and returns the hits in this key's current window. Throws if unreachable. */
  hit(key: string, windowMs: number): Promise<number>;
  close?(): Promise<void>;
}

/** The window a moment falls in; keys carry it so every instance counts the same window. */
export function windowOf(nowMs: number, windowMs: number): number {
  return Math.floor(nowMs / windowMs);
}

/** Counters in the channel store: one key per window, expiring with it. */
export class RedisRateLimitStore implements RateLimitStore {
  constructor(
    private readonly redis: Redis,
    private readonly now: () => number = Date.now,
  ) {}

  async hit(key: string, windowMs: number): Promise<number> {
    const windowKey = `ratelimit:${key}:${windowOf(this.now(), windowMs)}`;
    const results = await this.redis
      .multi()
      .incr(windowKey)
      .pexpire(windowKey, windowMs, 'NX')
      .exec();
    const [incr] = results ?? [];
    if (!incr || incr[0] || typeof incr[1] !== 'number') {
      throw new Error('rate limit counter did not increment');
    }
    return incr[1];
  }

  async close(): Promise<void> {
    await this.redis.quit().catch(() => this.redis.disconnect());
  }
}

/** Counters in this process, for tests and single-instance development. */
export class MemoryRateLimitStore implements RateLimitStore {
  private readonly counts = new Map<string, number>();

  constructor(private readonly now: () => number = Date.now) {}

  async hit(key: string, windowMs: number): Promise<number> {
    const windowKey = `${key}:${windowOf(this.now(), windowMs)}`;
    const count = (this.counts.get(windowKey) ?? 0) + 1;
    this.counts.set(windowKey, count);
    return count;
  }
}
