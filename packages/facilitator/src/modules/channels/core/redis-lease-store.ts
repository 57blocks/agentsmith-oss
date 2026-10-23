import { Redis, type Result } from 'ioredis';
import { ChannelStoreUnavailableError, type ChannelLog, type LeaseStore } from './channel-pool.js';

const MEMBERS_KEY = 'x402:channels';
const LEASE_KEY_PREFIX = 'x402:lease:';

// Lease keys are derived inside the script from member names, so the store must be one node, not a
// cluster. Members are tried in score order: the least recently leased first.
const ACQUIRE_LUA = `
for _, member in ipairs(redis.call('ZRANGE', KEYS[1], 0, -1)) do
  if redis.call('SET', ARGV[4] .. member, ARGV[1], 'NX', 'PX', ARGV[2]) then
    redis.call('ZADD', KEYS[1], 'XX', ARGV[3], member)
    return member
  end
end
return false
`;

const FINISH_LUA = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
if tonumber(ARGV[2]) <= 0 then
  redis.call('DEL', KEYS[1])
else
  redis.call('PEXPIRE', KEYS[1], ARGV[2])
end
return 1
`;

const SEED_LUA = `
if redis.call('EXISTS', KEYS[1]) == 1 then return 0 end
for _, address in ipairs(ARGV) do redis.call('ZADD', KEYS[1], 0, address) end
return 1
`;

/** Errors can quote the connection URL, which carries the store password; logs never do. */
export function withoutStoreUrls(message: string): string {
  return message.replace(/rediss?:\/\/\S*/gi, '<store url>');
}

function errorFields(error: unknown): { errorName: string; errorMessage: string } {
  if (!(error instanceof Error)) return { errorName: 'unknown', errorMessage: String(error) };
  return { errorName: error.name, errorMessage: withoutStoreUrls(error.message) };
}

declare module 'ioredis' {
  interface RedisCommander<Context> {
    channelAcquire(
      membersKey: string,
      token: string,
      ttlMs: number,
      nowMs: number,
      leaseKeyPrefix: string,
    ): Result<string | null, Context>;
    channelFinish(leaseKey: string, token: string, holdMs: number): Result<number, Context>;
    channelSeed(membersKey: string, ...addresses: string[]): Result<number, Context>;
  }
}

/**
 * A client that fails fast: no queueing while disconnected, no per-command retries, and a timeout on
 * every command. It connects in the background from construction and keeps reconnecting, so a
 * command issued before the first connection fails like one during an outage. Not `lazyConnect`:
 * with the offline queue off, its first command always fails. Logs once per outage, never the URL.
 */
export function createChannelStoreClient(
  url: string,
  options: { commandTimeoutMs: number; log: ChannelLog },
): Redis {
  const redis = new Redis(url, {
    enableOfflineQueue: false,
    maxRetriesPerRequest: 0,
    commandTimeout: options.commandTimeoutMs,
  });
  let down = false;
  redis.on('error', (error: Error) => {
    if (down) return;
    down = true;
    options.log.warn('channel_store_unavailable', errorFields(error));
  });
  redis.on('ready', () => {
    if (!down) return;
    down = false;
    options.log.info('channel_store_ready');
  });
  return redis;
}

const silentLog: ChannelLog = { info: () => {}, warn: () => {}, error: () => {} };

/**
 * `LeaseStore` on one Redis-protocol node. Any client error becomes `ChannelStoreUnavailableError`,
 * after one `channel_store_command_failed` log naming the command and the original error: a store
 * that is connected but refuses commands (auth, read-only, out of memory, timeouts) logs nothing
 * through the client's connection events.
 */
export class RedisLeaseStore implements LeaseStore {
  private seeded = false;
  private readonly log: ChannelLog;
  private readonly clock: { now(): number };

  constructor(
    private readonly redis: Redis,
    options: { log?: ChannelLog; clock?: { now(): number } } = {},
  ) {
    this.log = options.log ?? silentLog;
    this.clock = options.clock ?? Date;
    redis.defineCommand('channelAcquire', { numberOfKeys: 1, lua: ACQUIRE_LUA });
    redis.defineCommand('channelFinish', { numberOfKeys: 1, lua: FINISH_LUA });
    redis.defineCommand('channelSeed', { numberOfKeys: 1, lua: SEED_LUA });
  }

  async tryAcquire(request: { token: string; ttlMs: number }): Promise<string | undefined> {
    if (!this.seeded) throw new ChannelStoreUnavailableError('channel store is not seeded yet');
    const ttlMs = Math.ceil(request.ttlMs);
    const address = await this.call('acquire', () =>
      this.redis.channelAcquire(
        MEMBERS_KEY,
        request.token,
        ttlMs,
        this.clock.now(),
        LEASE_KEY_PREFIX,
      ),
    );
    return address ?? undefined;
  }

  async finish(address: string, token: string, holdMs: number): Promise<boolean> {
    const held = await this.call('finish', () =>
      this.redis.channelFinish(LEASE_KEY_PREFIX + address, token, Math.ceil(holdMs)),
    );
    return held === 1;
  }

  async seed(addresses: readonly string[]): Promise<void> {
    if (addresses.length > 0) {
      await this.call('seed', () => this.redis.channelSeed(MEMBERS_KEY, ...addresses));
    }
    this.seeded = true;
  }

  members(): Promise<string[]> {
    return this.call('members', () => this.redis.zrange(MEMBERS_KEY, '0', '-1'));
  }

  async removeMember(address: string): Promise<void> {
    await this.call('removeMember', () => this.redis.zrem(MEMBERS_KEY, address), {
      channel: address,
    });
  }

  private async call<T>(
    command: string,
    send: () => Promise<T>,
    fields: Record<string, unknown> = {},
  ): Promise<T> {
    try {
      return await send();
    } catch (error) {
      this.log.warn('channel_store_command_failed', { command, ...fields, ...errorFields(error) });
      throw new ChannelStoreUnavailableError('channel store did not answer', { cause: error });
    }
  }
}
