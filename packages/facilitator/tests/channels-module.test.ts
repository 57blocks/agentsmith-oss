import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { describe, expect, it, vi } from 'vitest';
import type { ChannelRuntime } from '../src/modules/channels/channel-runtime.js';
import { ChannelsModule } from '../src/modules/channels/channels.module.js';
import type { ChannelPool } from '../src/modules/channels/core/channel-pool.js';

function fakeRuntime() {
  return {
    pool: {} as ChannelPool,
    start: vi.fn(),
    stop: vi.fn(async () => {}),
  } satisfies ChannelRuntime;
}

describe('channels module lifecycle', () => {
  it('starts the runtime when the app starts and stops it when the app closes', async () => {
    const runtime = fakeRuntime();
    const app = await NestFactory.createApplicationContext(ChannelsModule.register(runtime), {
      logger: false,
    });

    await app.init();
    expect(runtime.start).toHaveBeenCalledTimes(1);
    expect(runtime.stop).not.toHaveBeenCalled();

    await app.close();
    expect(runtime.stop).toHaveBeenCalledTimes(1);
  });
});
