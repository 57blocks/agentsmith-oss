import { Redis } from 'ioredis';
import { vi } from 'vitest';

/**
 * Holds every Redis client built from now on before its first connection: ioredis connects from
 * its constructor, and the stubbed `connect` opens no socket, so a client stays not `ready` until a
 * test emits `ready` on it. Returns the clients as they are built; `vi.restoreAllMocks` undoes it.
 */
export function holdRedisBeforeConnecting(): Redis[] {
  const clients: Redis[] = [];
  vi.spyOn(Redis.prototype, 'connect').mockImplementation(function (this: Redis) {
    clients.push(this);
    return Promise.resolve();
  });
  return clients;
}
