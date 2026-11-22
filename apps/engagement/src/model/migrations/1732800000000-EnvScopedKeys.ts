import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * D-26 INV-ENV-SCHEMA. Every unique key of an environment-scoped table includes `sandbox`, or is a
 * surrogate key minted by us:
 *  - inbound_events: the casino event id is deduped per environment (a sandbox webhook can no longer
 *    swallow the production deposit, rc R2 / F5-DEDUPE-ENV);
 *  - item_player_usage: the per-player limit counter is per environment (D-28: sandbox orders do not
 *    count against it, but the key still names the environment);
 *  - spins: the client's Idempotency-Key is no longer unique by itself. The spin id is derived from
 *    the environment-scoped key (`scopedKey('spin', ...)`), so (tenant_id, id) is the dedupe key.
 * Existing rows are production.
 */
export class EnvScopedKeys1732800000000 implements MigrationInterface {
  name = 'EnvScopedKeys1732800000000';

  async up(q: QueryRunner): Promise<void> {
    await q.query(
      `ALTER TABLE "inbound_events" ADD COLUMN "sandbox" boolean NOT NULL DEFAULT false`,
    );
    await q.query(
      `ALTER TABLE "inbound_events" DROP CONSTRAINT "inbound_events_tenant_id_source_external_event_id_key"`,
    );
    await q.query(
      `ALTER TABLE "inbound_events" ADD UNIQUE ("tenant_id", "sandbox", "source", "external_event_id")`,
    );

    await q.query(
      `ALTER TABLE "item_player_usage" ADD COLUMN "sandbox" boolean NOT NULL DEFAULT false`,
    );
    await q.query(`ALTER TABLE "item_player_usage" DROP CONSTRAINT "item_player_usage_pkey"`);
    await q.query(
      `ALTER TABLE "item_player_usage" ADD PRIMARY KEY ("tenant_id", "item_id", "player_id", "sandbox")`,
    );

    await q.query(`ALTER TABLE "spins" DROP CONSTRAINT "spins_tenant_id_user_id_operation_id_key"`);
    await q.query(`CREATE INDEX "spins_operation" ON "spins" ("tenant_id", "operation_id")`);
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP INDEX "spins_operation"`);
    await q.query(`ALTER TABLE "spins" ADD UNIQUE ("tenant_id", "user_id", "operation_id")`);
    await q.query(`ALTER TABLE "item_player_usage" DROP CONSTRAINT "item_player_usage_pkey"`);
    await q.query(
      `ALTER TABLE "item_player_usage" ADD PRIMARY KEY ("tenant_id", "item_id", "player_id")`,
    );
    await q.query(`ALTER TABLE "item_player_usage" DROP COLUMN "sandbox"`);
    await q.query(
      `ALTER TABLE "inbound_events" DROP CONSTRAINT "inbound_events_tenant_id_sandbox_source_external_event_id_key"`,
    );
    await q.query(
      `ALTER TABLE "inbound_events" ADD UNIQUE ("tenant_id", "source", "external_event_id")`,
    );
    await q.query(`ALTER TABLE "inbound_events" DROP COLUMN "sandbox"`);
  }
}
