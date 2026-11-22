import type { MigrationInterface, QueryRunner } from 'typeorm';
import { TENANT_SETTING } from '@ex-mio/tenancy';

/**
 * rc review R5: `app.platform_scan` is a plain custom GUC, so a tenant-scoped transaction of the app
 * role could set it and read every tenant's queue rows. The scan branch of the policy now applies only
 * when NO tenant is set: the sweeper (a platform transaction) scans, a tenant transaction never does,
 * whatever it sets. Enforced here, in the policy, not in application code. WITH CHECK stays tenant-only.
 */
const PLATFORM_SCAN_SETTING = 'app.platform_scan';
const TENANT = `"tenant_id" = NULLIF(current_setting('${TENANT_SETTING}', true), '')::uuid`;
const SCAN_ANY = `COALESCE(current_setting('${PLATFORM_SCAN_SETTING}', true), '') = 'on'`;
const NO_TENANT = `NULLIF(current_setting('${TENANT_SETTING}', true), '') IS NULL`;

export class WorkQueueScanNoTenant1732700000000 implements MigrationInterface {
  name = 'WorkQueueScanNoTenant1732700000000';

  async up(q: QueryRunner): Promise<void> {
    await q.query(
      `ALTER POLICY "redemption_work_queue_tenant_isolation" ON "redemption_work_queue"
         USING (${TENANT} OR (${SCAN_ANY} AND ${NO_TENANT})) WITH CHECK (${TENANT})`,
    );
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(
      `ALTER POLICY "redemption_work_queue_tenant_isolation" ON "redemption_work_queue"
         USING (${TENANT} OR ${SCAN_ANY}) WITH CHECK (${TENANT})`,
    );
  }
}
