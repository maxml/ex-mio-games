import type { Client } from 'pg';
import { pgAs, SERVICES, type Service } from './env';

/**
 * What each runtime role may do, written out independently of the migrations that
 * grant it (apps/<service>/src/model/migrations/*-AppRoleGrants.ts). If a migration
 * grants more, or less, this fails: widening the app role is a deliberate edit of
 * BOTH places.
 */
const EXPECTED_GRANTS: Record<Service, Record<string, string[]>> = {
  // identity: AppRoleGrants (1732200001000) widened by IDENTITY_CORE_APP_GRANTS (1732300001000).
  // Identity CONSUMES audit.acting_request / audit.service_call (D-11, D-14) through its inbox, so
  // the app role needs the same inbox rights as every other consumer; without them no audit event
  // ever reaches audit_log (review finding, identity epic).
  identity: {
    audit_intents: ['DELETE', 'INSERT', 'SELECT'],
    audit_log: ['INSERT', 'SELECT'],
    inbox: ['INSERT', 'SELECT'],
    integration_credentials: ['INSERT', 'SELECT', 'UPDATE'],
    launch_jti: ['DELETE', 'INSERT', 'SELECT'],
    outbox: ['INSERT', 'SELECT', 'UPDATE'],
    player_links: ['DELETE', 'INSERT', 'SELECT'],
    provider_links: ['INSERT', 'SELECT'],
    signing_keys: ['INSERT', 'SELECT', 'UPDATE'],
    tenants: ['INSERT', 'SELECT', 'UPDATE'],
    user_roles: ['INSERT', 'SELECT'],
    users: ['INSERT', 'SELECT'],
  },
  engagement: {
    tenant_projections: ['INSERT', 'SELECT', 'UPDATE'],
    inbox: ['INSERT', 'SELECT'],
    outbox: ['INSERT', 'SELECT', 'UPDATE'],
  },
  payments: {
    coin_credits: ['INSERT', 'SELECT'],
    idempotency_keys: ['INSERT', 'SELECT'],
    outbox: ['INSERT', 'SELECT', 'UPDATE'],
  },
};

/** The bus tables carry a tenant_id for diagnosis only and are read across tenants by design. */
const BUS_TABLES = ['outbox', 'inbox'];

/**
 * A table WITH row-level security and a `<table>_tenant_isolation` policy, for the DDL case. Named
 * per service, not "the first granted non-bus table": for identity that would be `tenants`, the
 * registry, which has no RLS and no policy, so the RLS and DROP POLICY statements were not testing
 * what they claim.
 */
const RLS_TABLE: Record<Service, string> = {
  identity: 'users',
  engagement: 'tenant_projections',
  payments: 'coin_credits',
};

describe.each(SERVICES)('database roles: %s', (service) => {
  const app = `${service}_app` as const;
  const owner = `${service}_owner` as const;
  let admin: Client;
  let appDb: Client;

  beforeAll(async () => {
    admin = await pgAs('postgres', service);
    appDb = await pgAs(app);
  });
  afterAll(async () => {
    await admin?.end();
    await appDb?.end();
  });

  it('the app role is not a superuser, does not bypass RLS and owns nothing; the owner role owns the tables', async () => {
    const { rows: roles } = await admin.query(
      `SELECT rolname, rolsuper, rolbypassrls, rolcreaterole, rolcreatedb FROM pg_roles
        WHERE rolname = ANY($1) ORDER BY rolname`,
      [[app, owner]],
    );
    expect(roles).toHaveLength(2);
    for (const r of roles) {
      expect([r.rolsuper, r.rolbypassrls, r.rolcreaterole, r.rolcreatedb]).toEqual([
        false,
        false,
        false,
        false,
      ]);
    }
    const { rows: tables } = await admin.query(
      `SELECT c.relname, pg_get_userbyid(c.relowner) AS owner FROM pg_class c
        WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p')`,
    );
    expect(tables.length).toBeGreaterThan(0);
    expect(tables.every((t) => t.owner === owner)).toBe(true);
  });

  it('the app role holds exactly the listed table privileges and nothing else', async () => {
    const { rows } = await admin.query(
      `SELECT table_name, privilege_type FROM information_schema.table_privileges
        WHERE grantee = $1 AND table_schema = 'public' ORDER BY table_name, privilege_type`,
      [app],
    );
    const actual: Record<string, string[]> = {};
    for (const r of rows) (actual[r.table_name] ??= []).push(r.privilege_type);
    expect(actual).toEqual(EXPECTED_GRANTS[service]);
  });

  it('the app role cannot run DDL: no ALTER, no switching RLS off, no DROP, no CREATE', async () => {
    const tenantTable = RLS_TABLE[service];
    expect(Object.keys(EXPECTED_GRANTS[service])).toContain(tenantTable);
    const { rows: rls } = await admin.query(
      `SELECT c.relrowsecurity AS rls,
              EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid
                       AND p.polname = $1 || '_tenant_isolation') AS policy
         FROM pg_class c WHERE c.oid = $2::regclass`,
      [tenantTable, `"${tenantTable}"`],
    );
    // The statements below must hit a real RLS table with a real policy, or "permission denied"
    // proves nothing about RLS.
    expect(rls[0]).toEqual({ rls: true, policy: true });
    for (const sql of [
      `ALTER TABLE "${tenantTable}" NO FORCE ROW LEVEL SECURITY`,
      `ALTER TABLE "${tenantTable}" DISABLE ROW LEVEL SECURITY`,
      `ALTER TABLE "outbox" ADD COLUMN "x" int`,
      `DROP TABLE "${tenantTable}"`,
      `DROP POLICY "${tenantTable}_tenant_isolation" ON "${tenantTable}"`,
      `CREATE TABLE "sneaky" ("id" int)`,
      `TRUNCATE "outbox"`,
    ]) {
      await expect(appDb.query(sql)).rejects.toThrow(/must be owner|permission denied/);
    }
    // A GRANT by a role without the grant option is a WARNING ("no privileges were granted"), not
    // an error, so assert the effect: nothing reached PUBLIC (or anyone else) from the app role.
    await appDb.query(`GRANT ALL ON "outbox" TO PUBLIC`).catch(() => undefined);
    const { rows: leaked } = await admin.query(
      `SELECT grantee, privilege_type FROM information_schema.table_privileges
        WHERE table_schema = 'public' AND table_name = 'outbox' AND grantor = $1`,
      [app],
    );
    expect(leaked).toEqual([]);
  });

  it('a service role cannot connect to the postgres or template1 maintenance databases', async () => {
    for (const database of ['postgres', 'template1']) {
      await expect(pgAs(app, database)).rejects.toThrow(/permission denied/);
      await expect(pgAs(owner, database)).rejects.toThrow(/permission denied/);
    }
  });

  it('every tenant table has RLS enabled, forced and with a WITH CHECK, and every key carries tenant_id', async () => {
    const { rows: tables } = await admin.query(
      `SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity,
              (SELECT bool_and(p.polwithcheck IS NOT NULL) FROM pg_policy p WHERE p.polrelid = c.oid) AS checked,
              (SELECT count(*) FROM pg_policy p WHERE p.polrelid = c.oid)::int AS policies
         FROM pg_class c
         JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped
        WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r' AND c.relname <> ALL($1)`,
      [BUS_TABLES],
    );
    for (const t of tables) {
      expect({ table: t.relname, rls: t.relrowsecurity, forced: t.relforcerowsecurity }).toEqual({
        table: t.relname,
        rls: true,
        forced: true,
      });
      expect({ table: t.relname, policies: t.policies, checked: t.checked }).toEqual({
        table: t.relname,
        policies: 1,
        checked: true,
      });
      const { rows: keys } = await admin.query(
        `SELECT ic.relname AS index_name,
                bool_or(a.attname = 'tenant_id') AS has_tenant
           FROM pg_index i
           JOIN pg_class ic ON ic.oid = i.indexrelid
           CROSS JOIN LATERAL unnest(i.indkey::int2[]) AS k(attnum)
           JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
          WHERE i.indrelid = $1::regclass AND i.indisunique
          GROUP BY ic.relname`,
        [`"${t.relname}"`],
      );
      expect(keys.length).toBeGreaterThan(0);
      for (const k of keys) {
        expect({ index: k.index_name, hasTenant: k.has_tenant }).toEqual({
          index: k.index_name,
          hasTenant: true,
        });
      }
    }
  });
});
