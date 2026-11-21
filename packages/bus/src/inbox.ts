import type { Channel, ConsumeMessage } from 'amqplib';
import type { DataSource, EntityManager } from 'typeorm';
import { parseEvent, type EventEnvelope } from '@ex-mio/contracts';
import { runWithTenant, withTenantTransaction } from '@ex-mio/tenancy';
import { queueName } from './topology';

export type EventHandler = (manager: EntityManager, event: EventEnvelope) => Promise<void>;

export type ProcessOutcome = 'applied' | 'duplicate' | 'rejected';

export interface InboxOptions {
  dataSource: DataSource;
  channel: Channel;
  /** Service name: names the queue and keys the dedupe rows. */
  consumer: string;
  handler: EventHandler;
  prefetch?: number;
  onError?: (err: unknown, context: { reason: string; messageId?: string }) => void;
}

/**
 * Consumes a service's queue with exactly-once EFFECT on top of at-least-once
 * delivery:
 *  1. open a transaction that carries `SET LOCAL app.tenant_id` of the event;
 *  2. insert (consumer, event_id) into the inbox; a conflict means "seen":
 *     commit nothing, ack, done;
 *  3. otherwise run the handler in that same transaction, so the inbox row and
 *     the effect commit together or not at all;
 *  4. ack only after the commit. A crash between commit and ack redelivers the
 *     message, and step 2 turns it into a no-op.
 * A message that fails validation, or whose handler throws, is rejected without
 * requeue and lands in the service's dead-letter queue.
 */
export class InboxConsumer {
  private consumerTag: string | undefined;

  constructor(private readonly options: InboxOptions) {}

  async start(): Promise<void> {
    const { channel, consumer, prefetch = 10 } = this.options;
    await channel.prefetch(prefetch);
    const res = await channel.consume(queueName(consumer), (msg) => {
      if (msg) void this.onMessage(msg);
    });
    this.consumerTag = res.consumerTag;
  }

  async stop(): Promise<void> {
    if (this.consumerTag) await this.options.channel.cancel(this.consumerTag);
  }

  /** Process one message and settle it (ack or reject). Exposed for tests. */
  async onMessage(msg: ConsumeMessage): Promise<ProcessOutcome> {
    const { channel, onError } = this.options;
    let event: EventEnvelope;
    try {
      event = parseEvent(JSON.parse(msg.content.toString('utf8')));
    } catch (err) {
      onError?.(err, { reason: 'invalid message', messageId: msg.properties.messageId });
      channel.reject(msg, false);
      return 'rejected';
    }
    try {
      const outcome = await this.apply(event);
      channel.ack(msg);
      return outcome;
    } catch (err) {
      onError?.(err, { reason: 'handler failed', messageId: event.event_id });
      channel.reject(msg, false);
      return 'rejected';
    }
  }

  private async apply(event: EventEnvelope): Promise<'applied' | 'duplicate'> {
    const { dataSource, consumer, handler } = this.options;
    return withTenantTransaction(
      dataSource,
      async (manager) => {
        const inserted: unknown[] = await manager.query(
          `INSERT INTO "inbox" ("consumer", "event_id", "tenant_id") VALUES ($1, $2, $3)
           ON CONFLICT DO NOTHING RETURNING "event_id"`,
          [consumer, event.event_id, event.tenant_id],
        );
        if (inserted.length === 0) return 'duplicate' as const;
        await runWithTenant({ tenantId: event.tenant_id }, () => handler(manager, event));
        return 'applied' as const;
      },
      event.tenant_id,
    );
  }
}
