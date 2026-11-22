import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * D-29 INV-ENV-INPUT (docs/specs/env-input.md 3.5): no environment column keeps a DEFAULT. The
 * defaults were a backfill (existing rows are production; both columns are NOT NULL, so every row
 * already holds its real value). From now on a writer that forgets the column fails instead of
 * getting production.
 */
export class DropEnvironmentDefaults1732900000000 implements MigrationInterface {
  name = 'DropEnvironmentDefaults1732900000000';

  async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "integration_credentials" ALTER COLUMN "environment" DROP DEFAULT`);
    await q.query(`ALTER TABLE "launch_jti" ALTER COLUMN "sandbox" DROP DEFAULT`);
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(
      `ALTER TABLE "integration_credentials" ALTER COLUMN "environment" SET DEFAULT 'production'`,
    );
    await q.query(`ALTER TABLE "launch_jti" ALTER COLUMN "sandbox" SET DEFAULT false`);
  }
}
