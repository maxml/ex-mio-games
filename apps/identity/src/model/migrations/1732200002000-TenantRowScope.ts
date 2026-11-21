import type { MigrationInterface, QueryRunner } from 'typeorm';

const SCOPE = `NULLIF(current_setting('app.tenant_id', true), '')`;

/**
 * Row-level scope on `tenants`. A platform call (no `app.tenant_id`) sees every
 * tenant, as before. A call that runs inside a tenant sees only its own row, so a
 * bug in tenant-scoped code cannot list or create other tenants. The runtime role
 * is not the table owner, so the policy binds it without FORCE.
 */
export class TenantRowScope1732200002000 implements MigrationInterface {
  name = 'TenantRowScope1732200002000';

  async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "tenants" ENABLE ROW LEVEL SECURITY`);
    await q.query(
      `CREATE POLICY "tenants_tenant_isolation" ON "tenants"
         USING (${SCOPE} IS NULL OR "id" = ${SCOPE}::uuid)
         WITH CHECK (${SCOPE} IS NULL OR "id" = ${SCOPE}::uuid)`,
    );
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP POLICY IF EXISTS "tenants_tenant_isolation" ON "tenants"`);
    await q.query(`ALTER TABLE "tenants" DISABLE ROW LEVEL SECURITY`);
  }
}
