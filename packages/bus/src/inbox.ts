import type { Channel, ConsumeMessage } from 'amqplib';
import type { DataSource, EntityManager } from 'typeorm';
import { parseEvent, type EventEnvelope } from '@ex-mio/contracts';
import { runWithTenant, withTenantTransaction } from '@ex-mio/tenancy';
import { backoffMs, isTransientError, sleep, type BackoffOptions } from './retry';
import { queueName } from './topology';

export type EventHandler = (manager: EntityManager, event: EventEnvelope) => Promise<void>;

/** `retried`: a transient failure; the message went back to the queue after a delay. */
export type ProcessOutcome = 'applied' | 'duplicate' | 'rejected' | 'retried';

export interface InboxRetryOptions extends BackoffOptions {
  /** Total tries (first attempt included) before a transient failure is dead-lettered. */
  maxAttempts: number;
}

export const DEFAULT_INBOX_RETRY: InboxRetryOptions = {
  baseMs: 250,
  maxMs: 10_000,
  maxAttempts: 6,
};

export interface InboxOptions {
  dataSource: DataSource;
  channel: Channel;
  /** Service name: names the queue and keys the dedupe rows. */
  consumer: string;
  handler: EventHandler;
  prefetch?: number;
  retry?: InboxRetryOptions;
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
 * Failures are told apart:
 *  - an invalid message, or a handler failure that retrying cannot fix
 *    (validation, unknown type, a bug): rejected without requeue, so it lands in
 *    the service's dead-letter queue at once;
 *  - a transient failure (database connection, timeout, deadlock, serialization
 *    failure): the message waits out a bounded exponential backoff and is
 *    requeued. After `retry.maxAttempts` tries it is dead-lettered too.
 * The try count is kept per process: a restart starts counting again, which can
 * only retry more, never lose a message. Dead-lettered messages are read by the
 * depth monitor in `BusRuntime` and re-driven with the `dlq-replay` command.
 */
export class InboxConsumer {
  private consumerTag: string | undefined;
  private readonly attempts = new Map<string, number>();

  constructor(private readonly options: InboxOptions) {}

  async start(): Promise<void> {
    const { channel, consumer, prefetch = 10 } = this.options;
    await channel.prefetch(prefetch);
    const res = await channel.consume(queueName(consumer), (msg) => {
      if (msg) {
        this.onMessage(msg).catch((err: unknown) =>
          this.options.onError?.(err, { reason: 'message processing crashed' }),
        );
      }
    });
    this.consumerTag = res.consumerTag;
  }

  async stop(): Promise<void> {
    if (this.consumerTag) await this.options.channel.cancel(this.consumerTag);
  }

  /** Process one message and settle it (ack or reject). Exposed for tests. */
  async onMessage(msg: ConsumeMessage): Promise<ProcessOutcome> {
    const { channel, onError, retry = DEFAULT_INBOX_RETRY } = this.options;
    let event: EventEnvelope;
    try {
      event = parseEvent(JSON.parse(msg.content.toString('utf8')));
    } catch (err) {
      onError?.(err, { reason: 'invalid message', messageId: msg.properties.messageId });
      this.settle(() => channel.reject(msg, false));
      return 'rejected';
    }
    let outcome: 'applied' | 'duplicate';
    try {
      outcome = await this.apply(event);
    } catch (err) {
      const transient = isTransientError(err);
      const attempt = (this.attempts.get(event.event_id) ?? 0) + 1;
      if (transient && attempt < retry.maxAttempts) {
        this.attempts.set(event.event_id, attempt);
        onError?.(err, {
          reason: `transient failure, try ${attempt} of ${retry.maxAttempts}`,
          messageId: event.event_id,
        });
        await sleep(backoffMs(attempt, retry));
        this.settle(() => channel.reject(msg, true));
        return 'retried';
      }
      this.attempts.delete(event.event_id);
      onError?.(err, {
        reason: transient ? 'retries exhausted, dead-lettered' : 'permanent failure, dead-lettered',
        messageId: event.event_id,
      });
      this.settle(() => channel.reject(msg, false));
      return 'rejected';
    }
    this.attempts.delete(event.event_id);
    this.settle(() => channel.ack(msg));
    return outcome;
  }

  /**
   * Ack or reject, tolerating a channel that closed meanwhile. The effect is
   * already committed (or rolled back); an unsettled message is redelivered by the
   * broker and the inbox row turns the redelivery into a no-op. Settling errors
   * must never be mistaken for handler failures.
   */
  private settle(fn: () => void): void {
    try {
      fn();
    } catch (err) {
      this.options.onError?.(err, { reason: 'could not settle message; the broker redelivers it' });
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
