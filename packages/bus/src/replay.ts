import type { Channel, ConfirmChannel } from 'amqplib';
import { deadLetterQueueName, queueName } from './topology';

export interface ReplayResult {
  /** Messages in the dead-letter queue when the replay started. */
  depth: number;
  /** Messages moved back to the service's main queue. */
  replayed: number;
}

/** How many messages wait in `<service>.dlq`. The depth a monitor alerts on. */
export async function deadLetterDepth(channel: Channel, service: string): Promise<number> {
  return (await channel.checkQueue(deadLetterQueueName(service))).messageCount;
}

/**
 * Move dead-lettered messages back to the service's own queue (not the shared
 * exchange: other consumers already handled them). Each message is acked from the
 * DLQ only after the broker confirmed the republish, so a crash in the middle
 * duplicates at worst, which the inbox absorbs. At most the depth seen at the
 * start is processed, so a message that fails again and returns to the DLQ does
 * not make the command loop forever. `dryRun` only counts.
 */
export async function replayDeadLetters(
  channel: ConfirmChannel,
  service: string,
  options: { limit?: number; dryRun?: boolean } = {},
): Promise<ReplayResult> {
  const depth = await deadLetterDepth(channel, service);
  if (options.dryRun) return { depth, replayed: 0 };
  const max = Math.min(depth, options.limit ?? depth);
  let replayed = 0;
  while (replayed < max) {
    const msg = await channel.get(deadLetterQueueName(service), { noAck: false });
    if (!msg) break;
    channel.sendToQueue(queueName(service), msg.content, {
      persistent: true,
      messageId: msg.properties.messageId as string | undefined,
      contentType: msg.properties.contentType as string | undefined,
      type: msg.properties.type as string | undefined,
      headers: { 'x-replayed-from-dlq': true },
    });
    await channel.waitForConfirms();
    channel.ack(msg);
    replayed++;
  }
  return { depth, replayed };
}
