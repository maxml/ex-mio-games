import type { ConfirmChannel } from 'amqplib';
import type { DataSource, EntityManager } from 'typeorm';
import type { EventEnvelope } from '@ex-mio/contracts';
import { TENANT_SETTING } from '@ex-mio/tenancy';
import { backoffMs, type BackoffOptions } from './retry';
import { PLATFORM_SCAN_SETTING } from './sql';
import { EVENTS_EXCHANGE } from './topology';

/**
 * Run `fn` in a transaction that opted into the explicit platform scan (`app.platform_scan`) with no
 * tenant set: the only way to see the outbox across tenants (relay, stats, unpark). The same flag as
 * `Db.platformTx({ scan: true })`; the bus package cannot import service-kit, so it sets it here.
 */
export function scanTransaction<T>(
  dataSource: DataSource,
  fn: (manager: EntityManager) => Promise<T>,
): Promise<T> {
  return dataSource.transaction(async (manager) => {
    await manager.query(`SET LOCAL ${PLATFORM_SCAN_SETTING} = 'on'`);
    return fn(manager);
  });
}

/** An event was enqueued inside a transaction of one tenant with another tenant's id. */
export class OutboxTenantMismatchError extends Error {
  constructor() {
    super('event tenant differs from the transaction tenant: refusing to enqueue it');
    this.name = 'OutboxTenantMismatchError';
  }
}

/**
 * Record an event for publication. Call it with the EntityManager of the
 * transaction that makes the business change, so the change and the event
 * commit or roll back together. Nothing is sent to the broker here.
 *
 * Inside a tenant transaction (`app.tenant_id` set) the envelope must belong to
 * that tenant (the outbox policy enforces it too: WITH CHECK, FORCE RLS). A platform
 * transaction (no tenant setting) may enqueue for any tenant: the insert turns on the
 * platform-scan flag for the rest of that transaction (still no tenant set), so the row
 * passes the policy's scan branch.
 */
export async function enqueueEvent(manager: EntityManager, envelope: EventEnvelope): Promise<void> {
  const rows: { tenant: string | null }[] = await manager.query(
    `SELECT NULLIF(current_setting('${TENANT_SETTING}', true), '') AS "tenant"`,
  );
  const ambient = rows[0]?.tenant;
  if (ambient && ambient.toLowerCase() !== envelope.tenant_id.toLowerCase()) {
    throw new OutboxTenantMismatchError();
  }
  const params = [envelope.event_id, envelope.tenant_id, envelope.type, JSON.stringify(envelope)];
  if (ambient) {
    await manager.query(
      `INSERT INTO "outbox" ("event_id", "tenant_id", "type", "envelope") VALUES ($1, $2, $3, $4)`,
      params,
    );
    return;
  }
  // Platform transaction: opt this transaction into the platform scan (no tenant is set, so the
  // policy's scan branch applies) in the same statement as the insert.
  await manager.query(
    `WITH "scan" AS (SELECT set_config('${PLATFORM_SCAN_SETTING}', 'on', true))
     INSERT INTO "outbox" ("event_id", "tenant_id", "type", "envelope")
     SELECT $1::uuid, $2::uuid, $3::text, $4::jsonb FROM "scan"`,
    params,
  );
}

export interface RelayRetryOptions extends BackoffOptions {
  /** After this many failed publishes a row is parked. */
  maxAttempts: number;
}

export const DEFAULT_RELAY_RETRY: RelayRetryOptions = {
  baseMs: 5_000,
  maxMs: 300_000,
  maxAttempts: 8,
};

export interface ParkedRow {
  eventId: string;
  type: string;
  attempts: number;
}

export interface RelayOptions {
  dataSource: DataSource;
  channel: ConfirmChannel;
  batchSize?: number;
  intervalMs?: number;
  retry?: RelayRetryOptions;
  onError?: (err: unknown) => void;
  /** Called when a row used its last attempt and was parked: alert on it. */
  onParked?: (row: ParkedRow) => void;
}

interface OutboxRow {
  event_id: string;
  type: string;
  envelope: EventEnvelope;
  attempts: number;
}

/**
 * Reads due outbox rows and publishes them with publisher confirms. A row is
 * marked published only after the broker confirmed it AND did not return it as
 * unroutable (the publish is `mandatory`, so an event nobody is bound to yet is
 * kept, not dropped). A returned row gets its own backoff (`next_attempt_at`) and
 * attempt count; after `maxAttempts` it is parked. Either way it leaves the
 * batch, so unroutable rows never starve the routable rows behind them.
 * Delivery is at-least-once; consumers dedupe by `event_id` (see InboxConsumer).
 * `FOR UPDATE SKIP LOCKED` lets several relay instances run side by side.
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
    const { dataSource, channel, batchSize = 50, retry = DEFAULT_RELAY_RETRY } = this.options;
    const parked: ParkedRow[] = [];
    const published = await scanTransaction(dataSource, async (manager) => {
      const rows: OutboxRow[] = await manager.query(
        `SELECT "event_id", "type", "envelope", "attempts" FROM "outbox"
         WHERE "published_at" IS NULL AND "parked_at" IS NULL AND "next_attempt_at" <= now()
         ORDER BY "created_at", "event_id"
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
      for (const row of rows.filter((r) => this.returned.has(r.event_id))) {
        const attempts = row.attempts + 1;
        const park = attempts >= retry.maxAttempts;
        await manager.query(
          `UPDATE "outbox"
              SET "attempts" = $2,
                  "last_error" = $3,
                  "next_attempt_at" = now() + make_interval(secs => $4),
                  "parked_at" = CASE WHEN $5::boolean THEN now() END
            WHERE "event_id" = $1`,
          [
            row.event_id,
            attempts,
            'unroutable: no queue is bound to this event type',
            backoffMs(attempts, retry) / 1000,
            park,
          ],
        );
        if (park) parked.push({ eventId: row.event_id, type: row.type, attempts });
      }
      return done.length;
    });
    for (const row of parked) this.options.onParked?.(row);
    return published;
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

export interface OutboxStats {
  /** Rows still waiting to be published (including ones in backoff). */
  pending: number;
  /** Rows given up on: need an operator. */
  parked: number;
}

/** The numbers an alert needs: a growing `parked` means events are not being delivered. */
export async function outboxStats(dataSource: DataSource): Promise<OutboxStats> {
  const rows: { pending: string; parked: string }[] = await scanTransaction(dataSource, (m) =>
    m.query(
      `SELECT count(*) FILTER (WHERE "published_at" IS NULL AND "parked_at" IS NULL) AS "pending",
              count(*) FILTER (WHERE "published_at" IS NULL AND "parked_at" IS NOT NULL) AS "parked"
         FROM "outbox"`,
    ),
  );
  return { pending: Number(rows[0]?.pending ?? 0), parked: Number(rows[0]?.parked ?? 0) };
}

/** Give parked rows a fresh start (after the missing consumer was deployed). Returns how many. */
export async function unparkOutbox(dataSource: DataSource): Promise<number> {
  const result: [unknown[], number] = await scanTransaction(dataSource, (m) =>
    m.query(
      `UPDATE "outbox" SET "parked_at" = NULL, "attempts" = 0, "next_attempt_at" = now()
        WHERE "published_at" IS NULL AND "parked_at" IS NOT NULL`,
    ),
  );
  return result[1];
}
