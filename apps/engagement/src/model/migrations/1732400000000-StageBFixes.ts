import type { MigrationInterface, QueryRunner } from 'typeorm';
import { appRoleName, grantAppRole } from '@ex-mio/service-kit';
import { disableTenantRls, enableTenantRls } from '@ex-mio/tenancy';

/**
 * L4 stage B fix round (review F2, F3, decision D-18):
 *  - the order idempotency key includes the sandbox flag, so one key gives one order per mode;
 *  - the saga's inbox is its own table keyed by (tenant, consumer, event id): the bus inbox has no
 *    tenant in its key, so one tenant's event id could suppress another tenant's change.
 */
export class StageBFixes1732400000000 implements MigrationInterface {
  name = 'StageBFixes1732400000000';

  async up(q: QueryRunner): Promise<void> {
    // X-6: the casino request is built once, at RESERVED -> ISSUING, and frozen on the order (a later
    // erasure of the player link changes nothing); the issue deadline counts from the first ISSUING.
    await q.query(
      `ALTER TABLE "redemptions" ADD COLUMN "reward_request" jsonb, ADD COLUMN "first_issuing_at" timestamptz`,
    );
    await q.query(
      `ALTER TABLE "redemptions" DROP CONSTRAINT "redemptions_tenant_id_player_id_operation_key_key"`,
    );
    await q.query(
      `ALTER TABLE "redemptions" ADD CONSTRAINT "redemptions_order_key"
         UNIQUE ("tenant_id", "player_id", "sandbox", "operation_key")`,
    );
    await q.query(`
      CREATE TABLE "redemption_inbox" (
        "tenant_id" uuid NOT NULL,
        "consumer" text NOT NULL,
        "event_id" text NOT NULL,
        "received_at" timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY ("tenant_id", "consumer", "event_id")
      )`);
    await enableTenantRls(q, 'redemption_inbox');
    await grantAppRole(q, appRoleName('engagement'), { redemption_inbox: ['SELECT', 'INSERT'] });
  }

  async down(q: QueryRunner): Promise<void> {
    await disableTenantRls(q, 'redemption_inbox');
    await q.query(`DROP TABLE "redemption_inbox"`);
    await q.query(`ALTER TABLE "redemptions" DROP CONSTRAINT "redemptions_order_key"`);
    await q.query(
      `ALTER TABLE "redemptions" ADD CONSTRAINT "redemptions_tenant_id_player_id_operation_key_key"
         UNIQUE ("tenant_id", "player_id", "operation_key")`,
    );
    await q.query(
      `ALTER TABLE "redemptions" DROP COLUMN "reward_request", DROP COLUMN "first_issuing_at"`,
    );
  }
}
