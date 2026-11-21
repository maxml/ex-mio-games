import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * X-3 / D-13: an integration credential is issued for exactly one environment, and a launch
 * through it mints a player token with `sbx` or without. Existing rows are production.
 */
export class CredentialEnvironment1732300002000 implements MigrationInterface {
  name = 'CredentialEnvironment1732300002000';

  async up(q: QueryRunner): Promise<void> {
    await q.query(`
      ALTER TABLE "integration_credentials"
        ADD COLUMN "environment" text NOT NULL DEFAULT 'production'
        CHECK ("environment" IN ('production', 'sandbox'))`);
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "integration_credentials" DROP COLUMN "environment"`);
  }
}
