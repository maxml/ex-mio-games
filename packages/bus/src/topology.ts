import type { Channel } from 'amqplib';

/** Topic exchange all domain events are published to; routing key = event type. */
export const EVENTS_EXCHANGE = 'mio.events';
/** Dead-letter exchange: messages a consumer rejected end up here. */
export const DEAD_LETTER_EXCHANGE = 'mio.events.dlx';

export const queueName = (service: string): string => `${service}.events`;
export const deadLetterQueueName = (service: string): string => `${service}.dlq`;

/**
 * Declare the exchanges and one service's queue pair, idempotently. The main
 * queue dead-letters to `<service>.dlq` (via the DLX) when a consumer calls
 * `reject(msg, false)`, so a poison message parks there instead of looping.
 * `bindings` are the event types the service subscribes to.
 */
export async function assertTopology(
  channel: Channel,
  service: string,
  bindings: readonly string[],
): Promise<void> {
  await channel.assertExchange(EVENTS_EXCHANGE, 'topic', { durable: true });
  await channel.assertExchange(DEAD_LETTER_EXCHANGE, 'direct', { durable: true });
  await channel.assertQueue(deadLetterQueueName(service), { durable: true });
  await channel.bindQueue(deadLetterQueueName(service), DEAD_LETTER_EXCHANGE, service);
  await channel.assertQueue(queueName(service), {
    durable: true,
    arguments: {
      'x-dead-letter-exchange': DEAD_LETTER_EXCHANGE,
      'x-dead-letter-routing-key': service,
    },
  });
  for (const type of bindings) {
    await channel.bindQueue(queueName(service), EVENTS_EXCHANGE, type);
  }
}
