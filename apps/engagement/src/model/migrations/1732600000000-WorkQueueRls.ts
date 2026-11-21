import type { MigrationInterface, QueryRunner } from 'typeorm';
import { TENANT_SETTING } from '@ex-mio/tenancy';

/**
 * D-24: every tenant-scoped table has FORCE RLS, work queues included. `redemption_work_queue` carries
 * `tenant_id`, so it gets the same tenant policy as the rest. The sweeper has to find due work across
 * tenants without BYPASSRLS, so the one policy also lets a transaction that sets the narrow
 * `app.platform_scan` flag READ rows (USING); the WITH CHECK stays tenant-only, so a scan can never
 * write or move a row to another tenant.
 *
 * The key leads with `tenant_id` like every tenant table (a key without it is an existence oracle).
 */
const PLATFORM_SCAN_SETTING = 'app.platform_scan';

export class WorkQueueRls1732600000000 implements MigrationInterface {
  name = 'WorkQueueRls1732600000000';

  async up(q: QueryRunner): Promise<void> {
    const tenant = `"tenant_id" = NULLIF(current_setting('${TENANT_SETTING}', true), '')::uuid`;
    const scan = `COALESCE(current_setting('${PLATFORM_SCAN_SETTING}', true), '') = 'on'`;
    await q.query(
      `ALTER TABLE "redemption_work_queue" DROP CONSTRAINT "redemption_work_queue_pkey"`,
    );
    await q.query(
      `ALTER TABLE "redemption_work_queue" ADD PRIMARY KEY ("tenant_id", "redemption_id")`,
    );
    await q.query(`ALTER TABLE "redemption_work_queue" ENABLE ROW LEVEL SECURITY`);
    await q.query(`ALTER TABLE "redemption_work_queue" FORCE ROW LEVEL SECURITY`);
    await q.query(
      `CREATE POLICY "redemption_work_queue_tenant_isolation" ON "redemption_work_queue"
         USING (${tenant} OR ${scan}) WITH CHECK (${tenant})`,
    );
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(
      `DROP POLICY "redemption_work_queue_tenant_isolation" ON "redemption_work_queue"`,
    );
    await q.query(`ALTER TABLE "redemption_work_queue" NO FORCE ROW LEVEL SECURITY`);
    await q.query(`ALTER TABLE "redemption_work_queue" DISABLE ROW LEVEL SECURITY`);
    await q.query(
      `ALTER TABLE "redemption_work_queue" DROP CONSTRAINT "redemption_work_queue_pkey"`,
    );
    await q.query(`ALTER TABLE "redemption_work_queue" ADD PRIMARY KEY ("redemption_id")`);
  }
}
