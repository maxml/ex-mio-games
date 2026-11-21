import type { MigrationInterface, QueryRunner } from 'typeorm';
import { createBusTables, dropBusTables } from '@ex-mio/bus';

export class Init1732200000000 implements MigrationInterface {
  name = 'Init1732200000000';

  async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE "tenants" (
        "id" uuid PRIMARY KEY,
        "name" text NOT NULL,
        "slug" text NOT NULL UNIQUE,
        "created_at" timestamptz NOT NULL DEFAULT now()
      )`);
    // identity publishes (tenant.created) and so owns an outbox. No RLS on it: see @ex-mio/bus.
    await createBusTables(q);
  }

  async down(q: QueryRunner): Promise<void> {
    await dropBusTables(q);
    await q.query(`DROP TABLE "tenants"`);
  }
}
