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
  backoffMs,
  connectAmqp,
  deadLetterDepth,
  InboxConsumer,
  OutboxRelay,
  outboxStats,
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
  /** First reconnect delay and its cap. Default 500 ms and 15 s. */
  reconnect?: { baseMs: number; maxMs: number };
  /** How often the DLQ depth and parked outbox rows are checked and logged. Default 30 s; 0 disables. */
  monitorIntervalMs?: number;
}

type BusState = 'connecting' | 'up' | 'reconnecting' | 'stopped';

/** Everything that lives and dies with one broker connection. */
interface Session {
  connection: ChannelModel;
  channels: Channel[];
  relay?: OutboxRelay;
  consumer?: InboxConsumer;
}

/**
 * Wires a service to the broker: declares its queue and dead-letter queue, runs
 * the outbox relay when it publishes, and the inbox consumer when it subscribes.
 *
 * A broker restart or a dropped connection does not need a process restart: when
 * the connection or any of its channels closes, the whole session (relay,
 * consumer, channels) is torn down and rebuilt on a new connection, with
 * exponential backoff and the topology asserted again. `assertConnected()` (the
 * readiness probe) says the truth meanwhile: it throws until a session is fully
 * up, then recovers by itself.
 *
 * It also watches what needs a human: the dead-letter queue depth and parked
 * outbox rows are reported every `monitorIntervalMs`.
 */
@Injectable()
export class BusRuntime implements OnModuleInit, OnApplicationShutdown {
  private session: Session | undefined;
  private state: BusState = 'connecting';
  private lastError = '';
  private reconnectAttempt = 0;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private monitorTimer: NodeJS.Timeout | undefined;

  constructor(
    @Inject(BUS_OPTIONS) private readonly options: BusRuntimeOptions,
    @Inject(DATA_SOURCE) private readonly dataSource: DataSource,
    @Inject(BUS_HANDLER) private readonly handler: EventHandler | null,
  ) {}

  async onModuleInit(): Promise<void> {
    // The first connection must succeed (bounded retries), so a misconfigured URL
    // fails the boot instead of hiding behind a never-ready service.
    const connection = await connectAmqp(this.options.url);
    await this.startSession(connection);
    const interval = this.options.monitorIntervalMs ?? 30_000;
    if (interval > 0) {
      this.monitorTimer = setInterval(() => void this.monitor(), interval);
      this.monitorTimer.unref();
    }
  }

  isConnected(): boolean {
    return this.state === 'up';
  }

  /** For the readiness probe: throws unless the broker session is fully up. */
  assertConnected(): void {
    if (this.state !== 'up') {
      throw new Error(
        `broker connection is ${this.state}${this.lastError ? `: ${this.lastError}` : ''}`,
      );
    }
  }

  private async startSession(connection: ChannelModel): Promise<void> {
    const { service, bindings, publishes } = this.options;
    const session: Session = { connection, channels: [] };
    this.session = session;
    const lost = (why: string): void => this.onLost(session, why);
    connection.on('close', () => lost('connection closed'));
    connection.on('error', (err) => reportError(err, { phase: 'amqp' }));
    const track = (channel: Channel, name: string): void => {
      session.channels.push(channel);
      channel.on('close', () => lost(`${name} channel closed`));
      channel.on('error', (err) => reportError(err, { phase: 'amqp', channel: name }));
    };
    try {
      const setup = await connection.createChannel();
      await assertTopology(setup, service, bindings);
      await setup.close();

      if (publishes) {
        const channel: ConfirmChannel = await connection.createConfirmChannel();
        track(channel, 'relay');
        session.relay = new OutboxRelay({
          dataSource: this.dataSource,
          channel,
          onError: (err) => reportError(err, { phase: 'outbox-relay' }),
          onParked: (row) =>
            reportError(new Error('outbox row parked: no consumer took it'), {
              phase: 'outbox-parked',
              ...row,
            }),
        });
        session.relay.start();
      }
      if (bindings.length > 0 && this.handler) {
        const channel = await connection.createChannel();
        track(channel, 'consumer');
        session.consumer = new InboxConsumer({
          dataSource: this.dataSource,
          channel,
          consumer: service,
          handler: this.handler,
          onError: (err, context) => reportError(err, { phase: 'inbox', ...context }),
        });
        await session.consumer.start();
      }
    } catch (err) {
      if (this.session === session) this.session = undefined;
      await this.teardown(session);
      throw err;
    }
    if (this.state === 'stopped' || this.session !== session) {
      // Shut down, or lost again, while the session was being built.
      await this.teardown(session);
      return;
    }
    this.state = 'up';
    this.lastError = '';
    this.reconnectAttempt = 0;
  }

  private onLost(session: Session, why: string): void {
    if (this.session !== session || this.state === 'stopped') return;
    this.session = undefined;
    this.state = 'reconnecting';
    this.lastError = why;
    reportError(new Error(`broker ${why}; reconnecting`), { phase: 'amqp' });
    void this.teardown(session).then(() => this.scheduleReconnect());
  }

  private scheduleReconnect(): void {
    if (this.state === 'stopped' || this.reconnectTimer) return;
    const delay = backoffMs(
      ++this.reconnectAttempt,
      this.options.reconnect ?? { baseMs: 500, maxMs: 15_000 },
    );
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.reconnect();
    }, delay);
  }

  private async reconnect(): Promise<void> {
    if (this.isStopped()) return;
    try {
      const connection = await connectAmqp(this.options.url, { retries: 0, delayMs: 0 });
      if (this.isStopped()) {
        await connection.close().catch(() => undefined);
        return;
      }
      await this.startSession(connection);
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      this.scheduleReconnect();
    }
  }

  /** A method, so a check after an `await` is not narrowed away: shutdown can happen meanwhile. */
  private isStopped(): boolean {
    return this.state === 'stopped';
  }

  private async teardown(session: Session): Promise<void> {
    await session.relay?.stop().catch(() => undefined);
    await session.consumer?.stop().catch(() => undefined);
    for (const channel of session.channels) await channel.close().catch(() => undefined);
    await session.connection.close().catch(() => undefined);
  }

  /** Report what waits for a human: dead letters and parked outbox rows. */
  private async monitor(): Promise<void> {
    const session = this.session;
    if (!session || this.state !== 'up') return;
    try {
      const channel = await session.connection.createChannel();
      let dlq = 0;
      try {
        dlq = await deadLetterDepth(channel, this.options.service);
      } finally {
        await channel.close().catch(() => undefined);
      }
      const parked = this.options.publishes ? (await outboxStats(this.dataSource)).parked : 0;
      if (dlq > 0 || parked > 0) {
        reportError(new Error('messages wait for an operator: run dlq-replay'), {
          phase: 'bus-monitor',
          service: this.options.service,
          dlqDepth: dlq,
          parkedOutbox: parked,
        });
      }
    } catch (err) {
      reportError(err, { phase: 'bus-monitor' });
    }
  }

  async onApplicationShutdown(): Promise<void> {
    this.state = 'stopped';
    if (this.monitorTimer) clearInterval(this.monitorTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    const session = this.session;
    this.session = undefined;
    if (session) await this.teardown(session);
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
