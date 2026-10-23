import {
  Inject,
  Injectable,
  Module,
  type DynamicModule,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { CHANNEL_RUNTIME } from '../../common/tokens.js';
import type { ChannelRuntime } from './channel-runtime.js';

/** A class provider, so Nest is certain to call its lifecycle hooks. */
@Injectable()
class ChannelStoreLifecycle implements OnApplicationBootstrap, OnApplicationShutdown {
  constructor(@Inject(CHANNEL_RUNTIME) private readonly runtime: ChannelRuntime) {}

  onApplicationBootstrap(): void {
    this.runtime.start();
  }

  async onApplicationShutdown(): Promise<void> {
    await this.runtime.stop();
  }
}

/**
 * Provides the channel runtime, built before Nest like the payment engine, under
 * `CHANNEL_RUNTIME`; seeds and preloads it once the app has started, and closes it on shutdown.
 */
@Module({})
export class ChannelsModule {
  static register(runtime: ChannelRuntime): DynamicModule {
    return {
      module: ChannelsModule,
      providers: [{ provide: CHANNEL_RUNTIME, useValue: runtime }, ChannelStoreLifecycle],
      exports: [CHANNEL_RUNTIME],
    };
  }
}
