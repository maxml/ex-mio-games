import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * D-26 INV-ENV-SCHEMA: the casino chooses the jti, from a sandbox OR a production credential. The
 * single-use key now includes the environment, so a sandbox launch cannot burn a production jti.
 * Existing rows are production.
 */
export class LaunchJtiEnvironment1732300005000 implements MigrationInterface {
  name = 'LaunchJtiEnvironment1732300005000';

  async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "launch_jti" ADD COLUMN "sandbox" boolean NOT NULL DEFAULT false`);
    await q.query(`ALTER TABLE "launch_jti" DROP CONSTRAINT "launch_jti_pkey"`);
    await q.query(`ALTER TABLE "launch_jti" ADD PRIMARY KEY ("tenant_id", "sandbox", "jti")`);
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "launch_jti" DROP CONSTRAINT "launch_jti_pkey"`);
    await q.query(`ALTER TABLE "launch_jti" ADD PRIMARY KEY ("tenant_id", "jti")`);
    await q.query(`ALTER TABLE "launch_jti" DROP COLUMN "sandbox"`);
  }
}
