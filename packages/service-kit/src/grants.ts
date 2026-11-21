import type { QueryRunner } from 'typeorm';

export type TablePrivilege = 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE';

/** Table name to the exact privileges the runtime role gets on it. Nothing else is granted. */
export type AppGrants = Readonly<Record<string, readonly TablePrivilege[]>>;

const IDENT_RE = /^[a-z_][a-z0-9_]*$/;

function ident(name: string): string {
  if (!IDENT_RE.test(name)) throw new Error(`unsafe SQL identifier: ${name}`);
  return `"${name}"`;
}

/**
 * Each service has two database roles: `<service>_owner` owns the schema and runs
 * the migrations; `<service>_app` runs the service. The app role is not the owner,
 * so it cannot ALTER a table or switch row-level security off, and it holds only
 * what is listed here, in ONE migration per service (`AppRoleGrants`). A new table
 * is invisible to the app until a migration grants it.
 */
export const appRoleName = (service: string): string => `${service}_app`;

export function grantAppRoleSql(role: string, grants: AppGrants): string[] {
  const statements: string[] = [];
  for (const [table, privileges] of Object.entries(grants)) {
    statements.push(`REVOKE ALL ON ${ident(table)} FROM ${ident(role)}`);
    if (privileges.length > 0) {
      statements.push(`GRANT ${privileges.join(', ')} ON ${ident(table)} TO ${ident(role)}`);
    }
  }
  return statements;
}

export async function grantAppRole(
  queryRunner: QueryRunner,
  role: string,
  grants: AppGrants,
): Promise<void> {
  for (const sql of grantAppRoleSql(role, grants)) await queryRunner.query(sql);
}

export async function revokeAppRole(
  queryRunner: QueryRunner,
  role: string,
  grants: AppGrants,
): Promise<void> {
  for (const table of Object.keys(grants)) {
    await queryRunner.query(`REVOKE ALL ON ${ident(table)} FROM ${ident(role)}`);
  }
}
