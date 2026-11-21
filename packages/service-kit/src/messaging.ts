import {
  Inject,
  Injectable,
  Module,
  type DynamicModule,
  type OnApplicationShutdown,
  type OnModuleInit,
} from '@nestjs/common';
import type { Channel, ChannelModel, ConfirmChannel } from 'amqplib';
import type { DataSource } from 'typeorm';
import {
  assertTopology,
  connectAmqp,
  InboxConsumer,
  OutboxRelay,
  type EventHandler,
} from '@ex-mio/bus';
import { DATA_SOURCE } from './db';
import { reportError } from './error-reporter';

export const BUS_OPTIONS = Symbol('BUS_OPTIONS');
export const BUS_HANDLER = Symbol('BUS_HANDLER');

export interface BusRuntimeOptions {
  service: string;
  url: string;
  /** Event types this service consumes. Empty: the service only publishes. */
  bindings: readonly string[];
  /** Run the outbox relay (the service publishes events). */
  publishes: boolean;
}

/**
 * Wires a service to the broker: declares its queue and dead-letter queue, runs
 * the outbox relay when it publishes, and the inbox consumer when it subscribes.
 * Shuts both down with the app. `isConnected()` feeds the readiness check.
 */
@Injectable()
export class BusRuntime implements OnModuleInit, OnApplicationShutdown {
  private connection: ChannelModel | undefined;
  private relay: OutboxRelay | undefined;
  private consumer: InboxConsumer | undefined;
  private channels: Channel[] = [];
  private connected = false;

  constructor(
    @Inject(BUS_OPTIONS) private readonly options: BusRuntimeOptions,
    @Inject(DATA_SOURCE) private readonly dataSource: DataSource,
    @Inject(BUS_HANDLER) private readonly handler: EventHandler | null,
  ) {}

  async onModuleInit(): Promise<void> {
    const { service, url, bindings, publishes } = this.options;
    const connection = await connectAmqp(url);
    this.connection = connection;
    connection.on('close', () => (this.connected = false));
    connection.on('error', (err) => reportError(err, { phase: 'amqp' }));
    this.connected = true;

    const setup = await connection.createChannel();
    await assertTopology(setup, service, bindings);
    await setup.close();

    if (publishes) {
      const channel: ConfirmChannel = await connection.createConfirmChannel();
      this.channels.push(channel);
      this.relay = new OutboxRelay({
        dataSource: this.dataSource,
        channel,
        onError: (err) => reportError(err, { phase: 'outbox-relay' }),
      });
      this.relay.start();
    }
    if (bindings.length > 0 && this.handler) {
      const channel = await connection.createChannel();
      this.channels.push(channel);
      this.consumer = new InboxConsumer({
        dataSource: this.dataSource,
        channel,
        consumer: service,
        handler: this.handler,
        onError: (err, context) => reportError(err, { phase: 'inbox', ...context }),
      });
      await this.consumer.start();
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  /** For the readiness probe: throws when the broker connection is gone. */
  assertConnected(): void {
    if (!this.connected) throw new Error('broker connection is closed');
  }

  async onApplicationShutdown(): Promise<void> {
    await this.consumer?.stop().catch(() => undefined);
    await this.relay?.stop();
    for (const channel of this.channels) await channel.close().catch(() => undefined);
    await this.connection?.close().catch(() => undefined);
  }
}

export interface BusModuleOptions extends BusRuntimeOptions {
  /** Modules that provide what `handler.inject` needs. */
  imports?: DynamicModule['imports'];
  handler?: { inject: unknown[]; useFactory: (...deps: never[]) => EventHandler };
}

@Module({})
export class BusModule {
  /**
   * Call once per service and reuse the returned module object everywhere it is
   * imported: Nest treats a differently-built dynamic module as a new instance,
   * which would start a second consumer.
   */
  static register(options: BusModuleOptions): DynamicModule {
    const { handler, imports, ...runtime } = options;
    return {
      module: BusModule,
      imports: imports ?? [],
      providers: [
        { provide: BUS_OPTIONS, useValue: runtime },
        handler
          ? {
              provide: BUS_HANDLER,
              useFactory: handler.useFactory,
              inject: handler.inject as never[],
            }
          : { provide: BUS_HANDLER, useValue: null },
        BusRuntime,
      ],
      exports: [BusRuntime],
    };
  }
}
