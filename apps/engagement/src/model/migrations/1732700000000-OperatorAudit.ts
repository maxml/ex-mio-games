import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * D-27: rules and reward tables are published by an operator through `PUT /v1/operator/rules` and
 * `PUT /v1/operator/wheel`. Both tables are append-only for the runtime role, so the version rows are
 * the audit trail: each records WHO published it (the token's principal; for an acting platform
 * admin, the platform admin) and WHEN (`created_at` already exists). A row written by the default
 * seed on signup has `created_by = 'system'`. Rows from before this migration stay NULL.
 */
export class OperatorAudit1732700000000 implements MigrationInterface {
  name = 'OperatorAudit1732700000000';

  async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "rules" ADD COLUMN "created_by" text`);
    await q.query(`ALTER TABLE "reward_tables" ADD COLUMN "created_by" text`);
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "reward_tables" DROP COLUMN "created_by"`);
    await q.query(`ALTER TABLE "rules" DROP COLUMN "created_by"`);
  }
}
