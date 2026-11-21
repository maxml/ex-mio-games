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

interface KeyRow {
  index_name: string;
  is_primary: boolean;
  columns: string[];
}

/**
 * Make every key on a tenant table carry `tenant_id`. A key that does not
 * (`PRIMARY KEY (id)`) lets a tenant probe whether another tenant owns an id:
 * under RLS the insert of a foreign id fails with `duplicate key`. A primary key
 * is rebuilt as `(tenant_id, ...columns)`; any other unique index without
 * `tenant_id` cannot be fixed safely, so it throws and the migration fails.
 */
export async function ensureTenantKeys(queryRunner: QueryRunner, table: string): Promise<void> {
  const t = ident(table);
  const keys: KeyRow[] = await queryRunner.query(
    `SELECT ic.relname AS index_name, i.indisprimary AS is_primary,
            array_agg(a.attname ORDER BY k.ord) FILTER (WHERE a.attname IS NOT NULL) AS columns
       FROM pg_index i
       JOIN pg_class ic ON ic.oid = i.indexrelid
       CROSS JOIN LATERAL unnest(i.indkey::int2[]) WITH ORDINALITY AS k(attnum, ord)
       LEFT JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
      WHERE i.indrelid = $1::regclass AND i.indisunique
      GROUP BY ic.relname, i.indisprimary`,
    [t],
  );
  for (const key of keys) {
    if (key.columns?.includes('tenant_id')) continue;
    if (!key.is_primary) {
      throw new Error(
        `unique index ${key.index_name} on ${table} must include tenant_id (a cross-tenant existence oracle otherwise)`,
      );
    }
    const cols = ['tenant_id', ...(key.columns ?? [])].map(ident).join(', ');
    await queryRunner.query(`ALTER TABLE ${t} DROP CONSTRAINT ${ident(key.index_name)}`);
    await queryRunner.query(`ALTER TABLE ${t} ADD PRIMARY KEY (${cols})`);
  }
}

/** For a migration's `up`: `await enableTenantRls(queryRunner, 'coin_credits')`. */
export async function enableTenantRls(queryRunner: QueryRunner, table: string): Promise<void> {
  for (const sql of enableTenantRlsSql(table)) await queryRunner.query(sql);
  await ensureTenantKeys(queryRunner, table);
}

/** For a migration's `down`. */
export async function disableTenantRls(queryRunner: QueryRunner, table: string): Promise<void> {
  for (const sql of disableTenantRlsSql(table)) await queryRunner.query(sql);
}
