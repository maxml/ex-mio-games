import type { QueryRunner } from 'typeorm';
import { TENANT_SETTING } from './tx';

const IDENT_RE = /^[a-z_][a-z0-9_]*$/;

function ident(name: string): string {
  if (!IDENT_RE.test(name)) throw new Error(`unsafe SQL identifier: ${name}`);
  return `"${name}"`;
}

/**
 * SQL that turns row-level security on for `table`, keyed by its `tenant_id`
 * column. Three properties matter:
 *  - FORCE: the table owner (the service's own role) is subject to the policy too;
 *  - no setting means no rows: an empty or missing `app.tenant_id` yields NULL,
 *    and `tenant_id = NULL` is never true, so reads return nothing and writes fail;
 *  - WITH CHECK: an INSERT or UPDATE cannot move a row to another tenant.
 */
export function enableTenantRlsSql(table: string): string[] {
  const t = ident(table);
  const policy = ident(`${table}_tenant_isolation`);
  const expr = `"tenant_id" = NULLIF(current_setting('${TENANT_SETTING}', true), '')::uuid`;
  return [
    `ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY`,
    `ALTER TABLE ${t} FORCE ROW LEVEL SECURITY`,
    `CREATE POLICY ${policy} ON ${t} USING (${expr}) WITH CHECK (${expr})`,
  ];
}

export function disableTenantRlsSql(table: string): string[] {
  const t = ident(table);
  return [
    `DROP POLICY IF EXISTS ${ident(`${table}_tenant_isolation`)} ON ${t}`,
    `ALTER TABLE ${t} NO FORCE ROW LEVEL SECURITY`,
    `ALTER TABLE ${t} DISABLE ROW LEVEL SECURITY`,
  ];
}

/** For a migration's `up`: `await enableTenantRls(queryRunner, 'coin_credits')`. */
export async function enableTenantRls(queryRunner: QueryRunner, table: string): Promise<void> {
  for (const sql of enableTenantRlsSql(table)) await queryRunner.query(sql);
}

/** For a migration's `down`. */
export async function disableTenantRls(queryRunner: QueryRunner, table: string): Promise<void> {
  for (const sql of disableTenantRlsSql(table)) await queryRunner.query(sql);
}
