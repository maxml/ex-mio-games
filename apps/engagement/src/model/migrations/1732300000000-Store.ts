import type { MigrationInterface, QueryRunner } from 'typeorm';
import { appRoleName, grantAppRole, revokeAppRole, type AppGrants } from '@ex-mio/service-kit';
import { disableTenantRls, enableTenantRls } from '@ex-mio/tenancy';

/**
 * The runtime role's privileges on the store tables (the saga's inbox, `redemption_inbox`, is
 * granted by StageBFixes1732400000000). The app role never deletes an order or a history row.
 */
export const ENGAGEMENT_STORE_GRANTS: AppGrants = {
  store_items: ['SELECT', 'INSERT', 'UPDATE'],
  item_player_usage: ['SELECT', 'INSERT', 'UPDATE'],
  redemptions: ['SELECT', 'INSERT', 'UPDATE'],
  redemption_history: ['SELECT', 'INSERT'],
  redemption_work_queue: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'],
};

/**
 * Bonus store and redemption saga (spec section 5). Every tenant table is ENABLE + FORCE RLS.
 * `redemption_work_queue` has no RLS on purpose: ids and times only, so the sweeper finds work
 * across tenants without BYPASSRLS. `redemption_history` is append-only: UPDATE, DELETE and
 * TRUNCATE are revoked from every role, the owner included. Primary keys of tenant tables lead
 * with `tenant_id` (review F2), except the work queue's (it carries no tenant data).
 */
export class Store1732300000000 implements MigrationInterface {
  name = 'Store1732300000000';

  async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE "store_items" (
        "id" uuid NOT NULL,
        "tenant_id" uuid NOT NULL,
        "version" integer NOT NULL DEFAULT 1,
        "name" text NOT NULL,
        "description" text NOT NULL DEFAULT '',
        "image_url" text,
        "price" integer NOT NULL CHECK ("price" > 0),
        "reward" jsonb NOT NULL,
        "stock" integer CHECK ("stock" >= 0),
        "per_player_limit" integer CHECK ("per_player_limit" > 0),
        "active" boolean NOT NULL DEFAULT true,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY ("tenant_id", "id")
      )`);
    await q.query(`CREATE INDEX "store_items_tenant" ON "store_items" ("tenant_id", "active")`);

    await q.query(`
      CREATE TABLE "item_player_usage" (
        "tenant_id" uuid NOT NULL,
        "item_id" uuid NOT NULL,
        "player_id" text NOT NULL,
        "used" integer NOT NULL DEFAULT 0 CHECK ("used" >= 0),
        PRIMARY KEY ("tenant_id", "item_id", "player_id")
      )`);

    await q.query(`
      CREATE TABLE "redemptions" (
        "id" uuid NOT NULL,
        "tenant_id" uuid NOT NULL,
        "player_id" text NOT NULL,
        "sandbox" boolean NOT NULL,
        "item_id" uuid NOT NULL,
        "item_version" integer NOT NULL,
        "price" integer NOT NULL CHECK ("price" > 0),
        "reward" jsonb NOT NULL,
        "operation_key" text NOT NULL,
        "state" text NOT NULL,
        "attempts" integer NOT NULL DEFAULT 0,
        "next_attempt_at" timestamptz,
        "unknown_since" timestamptz,
        "casino_reference" text,
        "failure_reason" text,
        "reservation" text NOT NULL DEFAULT 'reserved'
          CHECK ("reservation" IN ('reserved', 'committed', 'released')),
        "created_at" timestamptz NOT NULL,
        "updated_at" timestamptz NOT NULL,
        PRIMARY KEY ("tenant_id", "id"),
        UNIQUE ("tenant_id", "player_id", "operation_key")
      )`);
    await q.query(
      `CREATE INDEX "redemptions_tenant_state" ON "redemptions" ("tenant_id", "state")`,
    );

    await q.query(`
      CREATE TABLE "redemption_history" (
        "id" bigint GENERATED ALWAYS AS IDENTITY,
        "tenant_id" uuid NOT NULL,
        "redemption_id" uuid NOT NULL,
        "from_state" text,
        "to_state" text NOT NULL,
        "cause" text NOT NULL,
        "at" timestamptz NOT NULL,
        PRIMARY KEY ("tenant_id", "id")
      )`);
    await q.query(
      `CREATE INDEX "redemption_history_redemption" ON "redemption_history" ("redemption_id", "id")`,
    );

    await q.query(`
      CREATE TABLE "redemption_work_queue" (
        "redemption_id" uuid PRIMARY KEY,
        "tenant_id" uuid NOT NULL,
        "next_attempt_at" timestamptz
      )`);
    await q.query(
      `CREATE INDEX "redemption_work_queue_due" ON "redemption_work_queue" ("next_attempt_at" NULLS FIRST)`,
    );

    for (const table of ['store_items', 'item_player_usage', 'redemptions', 'redemption_history'])
      await enableTenantRls(q, table);

    await q.query(`REVOKE UPDATE, DELETE, TRUNCATE ON "redemption_history" FROM PUBLIC`);
    await q.query(`DO $$ BEGIN
      EXECUTE format('REVOKE UPDATE, DELETE, TRUNCATE ON "redemption_history" FROM %I', current_user);
    END $$`);

    await grantAppRole(q, appRoleName('engagement'), ENGAGEMENT_STORE_GRANTS);
  }

  async down(q: QueryRunner): Promise<void> {
    await revokeAppRole(q, appRoleName('engagement'), ENGAGEMENT_STORE_GRANTS);
    await q.query(`DROP TABLE "redemption_work_queue"`);
    for (const table of ['redemption_history', 'redemptions', 'item_player_usage', 'store_items']) {
      await disableTenantRls(q, table);
      await q.query(`DROP TABLE "${table}"`);
    }
  }
}
