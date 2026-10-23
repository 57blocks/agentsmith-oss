import { createHash } from 'node:crypto';
import type { SettleResponse } from '@x402/core/types';

interface CachedSettlement {
  expiresAt: number;
  response: SettleResponse;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export function settlementKey(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex');
}

export class SettlementCoordinator {
  private readonly inFlight = new Map<string, Promise<SettleResponse>>();
  private readonly completed = new Map<string, CachedSettlement>();

  constructor(
    private readonly ttlMs: number,
    private readonly maxEntries: number,
  ) {}

  run(key: string, operation: () => Promise<SettleResponse>): Promise<SettleResponse> {
    const now = Date.now();
    const cached = this.completed.get(key);
    if (cached && cached.expiresAt > now) return Promise.resolve(cached.response);
    if (cached) this.completed.delete(key);

    const running = this.inFlight.get(key);
    if (running) return running;

    const promise = operation()
      .then((response) => {
        if (response.success) {
          const settledAt = Date.now();
          this.prune(settledAt);
          this.completed.set(key, { expiresAt: settledAt + this.ttlMs, response });
        }
        return response;
      })
      .finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, promise);
    return promise;
  }

  private prune(now: number) {
    for (const [key, entry] of this.completed) {
      if (entry.expiresAt <= now) this.completed.delete(key);
    }
    while (this.completed.size >= this.maxEntries) {
      const oldest = this.completed.keys().next().value as string | undefined;
      if (!oldest) break;
      this.completed.delete(oldest);
    }
  }
}
