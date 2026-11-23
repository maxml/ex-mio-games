import type { QueryRunner } from 'typeorm';
import { ensureTenantKeys, TENANT_SETTING } from '@ex-mio/tenancy';

/** The opt-in flag of a platform scan: honoured only by policies, and only with no tenant set. */
export const PLATFORM_SCAN_SETTING = 'app.platform_scan';

/**
 * DDL for the two bus tables every service that publishes or consumes owns in
 * its own database. Both carry tenant data (the envelope, the consumed event ids), so
 * `addBusTablesTenantRls` (a forward migration, run after this DDL) puts FORCE row-level
 * security on them: a tenant sees its own rows; the relay, the stats and the unpark path
 * read across tenants only through an explicit platform scan (see `scanTransaction`).
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

const TENANT_MATCH = `"tenant_id" = NULLIF(current_setting('${TENANT_SETTING}', true), '')::uuid`;
const NO_TENANT = `NULLIF(current_setting('${TENANT_SETTING}', true), '') IS NULL`;
const SCAN_ON = `COALESCE(current_setting('${PLATFORM_SCAN_SETTING}', true), '') = 'on'`;
/** Tenant rows are visible to their tenant; the platform path must opt in AND have no tenant set. */
const BUS_POLICY = `${TENANT_MATCH} OR (${SCAN_ON} AND ${NO_TENANT})`;
const BUS_RLS_TABLES = ['outbox', 'inbox'] as const;

/**
 * Forward migration (all three services): ENABLE + FORCE row-level security on `outbox` and `inbox`,
 * ONE policy each (USING = WITH CHECK = tenant match OR explicit platform scan with no tenant),
 * and keys led by `tenant_id` (outbox `(tenant_id, event_id)`, inbox `(tenant_id, consumer, event_id)`).
 * `tenant_id` is already NOT NULL on both tables, so there is nothing to backfill.
 */
export async function addBusTablesTenantRls(q: QueryRunner): Promise<void> {
  for (const t of BUS_RLS_TABLES) {
    await q.query(`ALTER TABLE "${t}" ENABLE ROW LEVEL SECURITY`);
    await q.query(`ALTER TABLE "${t}" FORCE ROW LEVEL SECURITY`);
    await q.query(
      `CREATE POLICY "${t}_tenant_isolation" ON "${t}" USING (${BUS_POLICY}) WITH CHECK (${BUS_POLICY})`,
    );
    await ensureTenantKeys(q, t);
  }
}

export async function removeBusTablesTenantRls(q: QueryRunner): Promise<void> {
  await q.query(`ALTER TABLE "inbox" DROP CONSTRAINT "inbox_pkey"`);
  await q.query(`ALTER TABLE "inbox" ADD PRIMARY KEY ("consumer", "event_id")`);
  await q.query(`ALTER TABLE "outbox" DROP CONSTRAINT "outbox_pkey"`);
  await q.query(`ALTER TABLE "outbox" ADD PRIMARY KEY ("event_id")`);
  for (const t of BUS_RLS_TABLES) {
    await q.query(`DROP POLICY "${t}_tenant_isolation" ON "${t}"`);
    await q.query(`ALTER TABLE "${t}" NO FORCE ROW LEVEL SECURITY`);
    await q.query(`ALTER TABLE "${t}" DISABLE ROW LEVEL SECURITY`);
  }
}
