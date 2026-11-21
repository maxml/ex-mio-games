import type { MigrationInterface, QueryRunner } from 'typeorm';
import { createBusTables, dropBusTables } from '@ex-mio/bus';
import { disableTenantRls, enableTenantRls } from '@ex-mio/tenancy';

export class Init1732200000000 implements MigrationInterface {
  name = 'Init1732200000000';

  async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE "tenant_projections" (
        "tenant_id" uuid PRIMARY KEY,
        "name" text NOT NULL,
        "slug" text NOT NULL,
        "applied_count" integer NOT NULL DEFAULT 1
      )`);
    await enableTenantRls(q, 'tenant_projections');
    // engagement consumes events: it owns an inbox (and an outbox for the events it will publish).
    await createBusTables(q);
  }

  async down(q: QueryRunner): Promise<void> {
    await dropBusTables(q);
    await disableTenantRls(q, 'tenant_projections');
    await q.query(`DROP TABLE "tenant_projections"`);
  }
}
