import type { QueryRunner } from 'typeorm';

/**
 * DDL for the two bus tables every service that publishes or consumes owns in
 * its own database. Neither has row-level security on purpose: the relay and the
 * dedupe check work across tenants; both rows carry `tenant_id` for diagnosis.
 *
 * outbox: one row per event, written in the same transaction as the business
 *   change. `published_at` stays NULL until the broker confirmed the publish.
 *   A row the broker cannot route is retried with a per-row backoff
 *   (`attempts`, `next_attempt_at`) and, after the last attempt, parked
 *   (`parked_at`) so it never blocks the rows behind it. A parked row waits for
 *   an operator (`dlq-replay --outbox`).
 * inbox: one row per (consumer, event), written in the same transaction as the
 *   effect. The primary key is what makes a redelivery a no-op.
 */
export const BUS_TABLES_UP: readonly string[] = [
  `CREATE TABLE "outbox" (
     "event_id" uuid PRIMARY KEY,
     "tenant_id" uuid NOT NULL,
     "type" text NOT NULL,
     "envelope" jsonb NOT NULL,
     "created_at" timestamptz NOT NULL DEFAULT now(),
     "published_at" timestamptz,
     "attempts" integer NOT NULL DEFAULT 0,
     "next_attempt_at" timestamptz NOT NULL DEFAULT now(),
     "parked_at" timestamptz,
     "last_error" text
   )`,
  `CREATE INDEX "outbox_due" ON "outbox" ("next_attempt_at", "created_at", "event_id")
     WHERE "published_at" IS NULL AND "parked_at" IS NULL`,
  `CREATE TABLE "inbox" (
     "consumer" text NOT NULL,
     "event_id" uuid NOT NULL,
     "tenant_id" uuid NOT NULL,
     "received_at" timestamptz NOT NULL DEFAULT now(),
     PRIMARY KEY ("consumer", "event_id")
   )`,
];

export const BUS_TABLES_DOWN: readonly string[] = [`DROP TABLE "inbox"`, `DROP TABLE "outbox"`];

export async function createBusTables(queryRunner: QueryRunner): Promise<void> {
  for (const sql of BUS_TABLES_UP) await queryRunner.query(sql);
}

export async function dropBusTables(queryRunner: QueryRunner): Promise<void> {
  for (const sql of BUS_TABLES_DOWN) await queryRunner.query(sql);
}
