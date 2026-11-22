import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * D-29 INV-ENV-INPUT (docs/specs/env-input.md 3.5): no environment column keeps a DEFAULT. The
 * defaults were a backfill (existing rows are production; the columns are NOT NULL, so every row
 * already holds its real value). A writer that forgets `sandbox` now fails instead of getting
 * production.
 */
export class DropEnvironmentDefaults1732900000000 implements MigrationInterface {
  name = 'DropEnvironmentDefaults1732900000000';

  async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "wallets" ALTER COLUMN "sandbox" DROP DEFAULT`);
    await q.query(`ALTER TABLE "wallet_owner_links" ALTER COLUMN "sandbox" DROP DEFAULT`);
    await q.query(`ALTER TABLE "accounts" ALTER COLUMN "sandbox" DROP DEFAULT`);
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "wallets" ALTER COLUMN "sandbox" SET DEFAULT false`);
    await q.query(`ALTER TABLE "wallet_owner_links" ALTER COLUMN "sandbox" SET DEFAULT false`);
    await q.query(`ALTER TABLE "accounts" ALTER COLUMN "sandbox" SET DEFAULT false`);
  }
}
