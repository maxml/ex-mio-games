import type { ConfirmChannel } from 'amqplib';
import type { DataSource, EntityManager } from 'typeorm';
import type { EventEnvelope } from '@ex-mio/contracts';
import { EVENTS_EXCHANGE } from './topology';

/**
 * Record an event for publication. Call it with the EntityManager of the
 * transaction that makes the business change, so the change and the event
 * commit or roll back together. Nothing is sent to the broker here.
 */
export async function enqueueEvent(manager: EntityManager, envelope: EventEnvelope): Promise<void> {
  await manager.query(
    `INSERT INTO "outbox" ("event_id", "tenant_id", "type", "envelope") VALUES ($1, $2, $3, $4)`,
    [envelope.event_id, envelope.tenant_id, envelope.type, JSON.stringify(envelope)],
  );
}

export interface RelayOptions {
  dataSource: DataSource;
  channel: ConfirmChannel;
  batchSize?: number;
  intervalMs?: number;
  onError?: (err: unknown) => void;
}

interface OutboxRow {
  event_id: string;
  type: string;
  envelope: EventEnvelope;
}

/**
 * Reads unpublished outbox rows and publishes them with publisher confirms.
 * A row is marked published only after the broker confirmed it AND did not
 * return it as unroutable (the publish is `mandatory`). Anything else stays in
 * the table and is retried, so delivery is at-least-once; consumers dedupe by
 * `event_id` (see InboxConsumer). `FOR UPDATE SKIP LOCKED` lets several relay
 * instances run side by side without publishing the same row twice at once.
 */
export class OutboxRelay {
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private stopped = false;
  private readonly returned = new Set<string>();

  constructor(private readonly options: RelayOptions) {
    options.channel.on('return', (msg) => {
      const id = msg.properties.messageId as string | undefined;
      if (id) this.returned.add(id);
    });
  }

  /** Publish one batch. Returns how many rows were confirmed and marked published. */
  async pollOnce(): Promise<number> {
    const { dataSource, channel, batchSize = 50 } = this.options;
    return dataSource.transaction(async (manager) => {
      const rows: OutboxRow[] = await manager.query(
        `SELECT "event_id", "type", "envelope" FROM "outbox"
         WHERE "published_at" IS NULL ORDER BY "created_at", "event_id"
         LIMIT $1 FOR UPDATE SKIP LOCKED`,
        [batchSize],
      );
      if (rows.length === 0) return 0;
      this.returned.clear();
      for (const row of rows) {
        channel.publish(EVENTS_EXCHANGE, row.type, Buffer.from(JSON.stringify(row.envelope)), {
          persistent: true,
          mandatory: true,
          messageId: row.event_id,
          contentType: 'application/json',
          type: row.type,
        });
      }
      await channel.waitForConfirms();
      const done = rows.filter((r) => !this.returned.has(r.event_id)).map((r) => r.event_id);
      if (done.length > 0) {
        await manager.query(
          `UPDATE "outbox" SET "published_at" = now() WHERE "event_id" = ANY($1::uuid[])`,
          [done],
        );
      }
      return done.length;
    });
  }

  start(): void {
    const { intervalMs = 500, onError } = this.options;
    const tick = async (): Promise<void> => {
      if (this.stopped) return;
      this.running = true;
      try {
        // Drain while there is work, then sleep.
        while (!this.stopped && (await this.pollOnce()) > 0) {
          /* keep draining */
        }
      } catch (err) {
        onError?.(err);
      } finally {
        this.running = false;
      }
      if (!this.stopped) this.timer = setTimeout(() => void tick(), intervalMs);
    };
    void tick();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    while (this.running) await new Promise((r) => setTimeout(r, 10));
  }
}
