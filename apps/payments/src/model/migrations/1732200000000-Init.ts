import type { MigrationInterface, QueryRunner } from 'typeorm';
import { createBusTables, dropBusTables } from '@ex-mio/bus';
import { createIdempotencyTable, dropIdempotencyTable } from '@ex-mio/idempotency';
import { disableTenantRls, enableTenantRls } from '@ex-mio/tenancy';

export class Init1732200000000 implements MigrationInterface {
  name = 'Init1732200000000';

  async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE "coin_credits" (
        "id" uuid NOT NULL,
        "tenant_id" uuid NOT NULL,
        "player_id" uuid NOT NULL,
        "amount" integer NOT NULL CHECK ("amount" > 0),
        "created_at" timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY ("tenant_id", "id")
      )`);
    await q.query(
      `CREATE INDEX "coin_credits_tenant_created" ON "coin_credits" ("tenant_id", "created_at")`,
    );
    await enableTenantRls(q, 'coin_credits');
    await createIdempotencyTable(q);
    await createBusTables(q);
  }

  async down(q: QueryRunner): Promise<void> {
    await dropBusTables(q);
    await dropIdempotencyTable(q);
    await disableTenantRls(q, 'coin_credits');
    await q.query(`DROP TABLE "coin_credits"`);
  }
}
