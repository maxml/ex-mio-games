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
    // D-27 RewardApis (1732300004000): the PUT upserts (INSERT ... ON CONFLICT UPDATE), the
    // integration route reads. No DELETE: a reward API is replaced, never removed by the app.
    reward_apis: ['INSERT', 'SELECT', 'UPDATE'],
    signing_keys: ['INSERT', 'SELECT', 'UPDATE'],
    tenants: ['INSERT', 'SELECT', 'UPDATE'],
    user_roles: ['INSERT', 'SELECT'],
    users: ['INSERT', 'SELECT'],
  },
  engagement: {
    // L3 review F2: the ingest tables. Column grant UPDATE (status, used_at) on spin_credits is not
    // listed here (table_privileges has no columns); INV-ENGAGEMENT-SCHEMA-DB pins it.
    audit_intents: ['DELETE', 'INSERT', 'SELECT'], // 1732500000000-AuditIntents (D-23 / F4)
    inbound_events: ['INSERT', 'SELECT'],
    inbox: ['INSERT', 'SELECT'],
    outbox: ['INSERT', 'SELECT', 'UPDATE'],
    reward_tables: ['INSERT', 'SELECT'],
    rules: ['INSERT', 'SELECT'],
    spin_credits: ['INSERT', 'SELECT'],
    spins: ['INSERT', 'SELECT'],
    tenant_projections: ['INSERT', 'SELECT', 'UPDATE'],
    // The store tables (Store1732300000000, StageBFixes1732400000000).
    item_player_usage: ['INSERT', 'SELECT', 'UPDATE'],
    redemption_history: ['INSERT', 'SELECT'],
    redemption_inbox: ['INSERT', 'SELECT'],
    redemption_work_queue: ['DELETE', 'INSERT', 'SELECT', 'UPDATE'],
    redemptions: ['INSERT', 'SELECT', 'UPDATE'],
    store_items: ['INSERT', 'SELECT', 'UPDATE'],
  },
  // The ledger replaced `coin_credits`; column-level UPDATEs (balances.amount, reserves.state*) do not
  // show in table_privileges and are pinned by apps/payments ledger.schema.pgtest.ts.
  payments: {
    accounts: ['INSERT', 'SELECT'],
    audit_intents: ['DELETE', 'INSERT', 'SELECT'], // 1732300002000-AuditIntents (D-23 / F4)
    balances: ['INSERT', 'SELECT'],
    billing_plans: ['SELECT'],
    billing_webhook_events: ['INSERT', 'SELECT'],
    idempotency_keys: ['INSERT', 'SELECT'],
    inbox: ['INSERT', 'SELECT'],
    invoices: ['INSERT', 'SELECT'],
    journal_transactions: ['INSERT', 'SELECT'],
    ledger_entries: ['INSERT', 'SELECT'],
    outbox: ['INSERT', 'SELECT', 'UPDATE'],
    payment_attempts: ['INSERT', 'SELECT', 'UPDATE'],
    reconciliation_runs: ['INSERT', 'SELECT'],
    reconciliation_tenants: ['INSERT', 'SELECT'],
    reserves: ['INSERT', 'SELECT'],
    subscriptions: ['INSERT', 'SELECT', 'UPDATE'],
    usage_events: ['INSERT', 'SELECT'],
    usage_meters: ['INSERT', 'SELECT', 'UPDATE'],
    usage_players: ['INSERT', 'SELECT'],
    usage_reports: ['INSERT', 'SELECT'],
    wallet_owner_links: ['DELETE', 'INSERT', 'SELECT'],
    wallets: ['INSERT', 'SELECT'],
  },
};

/**
 * D-24: a truly global table that carries a tenant_id column is named here WITH its reason, never
 * skipped silently. Work queues and job tables that hold tenant data are NOT here: they get FORCE
 * RLS like any tenant table (engagement `redemption_work_queue` is a coder item, D-24).
 * Mutation: add a table here without a reason, or add a work queue that holds tenant data.
 */
const PLATFORM_TABLES: Record<string, string> = {
  reconciliation_tenants:
    'payments: an id-only registry (tenant_id PRIMARY KEY, no other column) that the scheduled reconciliation job lists to know which tenants to check, without BYPASSRLS; it holds no tenant data',
};

/**
 * A table WITH row-level security and a `<table>_tenant_isolation` policy, for the DDL case. Named
 * per service, not "the first granted non-bus table": for identity that would be `tenants`, the
 * registry, which has no RLS and no policy, so the RLS and DROP POLICY statements were not testing
 * what they claim.
 */
/**
 * Tables that MUST be in the tenant-table set of the RLS check below (they hold a tenant's secrets
 * or integration settings). The check finds tenant tables by their `tenant_id` column; naming these
 * stops one from leaving that set silently (a renamed column) and passing with no RLS.
 * Mutation: `disableTenantRls(q, 'reward_apis')` in RewardApis1732300004000.up -> red.
 */
const MUST_BE_TENANT_TABLES: Record<Service, string[]> = {
  identity: ['integration_credentials', 'reward_apis'],
  engagement: [],
  payments: [],
};

const RLS_TABLE: Record<Service, string> = {
  identity: 'users',
  engagement: 'tenant_projections',
  payments: 'accounts', // the ledger replaced coin_credits; `accounts` is an RLS table with its policy
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
      [Object.keys(PLATFORM_TABLES)],
    );
    // A platform table earns its place only while it holds no tenant data: tenant_id and nothing else.
    for (const name of Object.keys(PLATFORM_TABLES)) {
      const { rows: cols } = await admin.query(
        `SELECT column_name::text AS c FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = $1`,
        [name],
      );
      if (cols.length > 0) expect([name, cols.map((r) => r.c)]).toEqual([name, ['tenant_id']]);
    }
    expect(
      MUST_BE_TENANT_TABLES[service].filter((n) => !tables.some((t) => t.relname === n)),
    ).toEqual([]);
    // every offender by name (D-24), so one run lists all of them
    expect(
      tables
        .filter((t) => !(t.relrowsecurity && t.relforcerowsecurity))
        .map((t) => t.relname as string),
    ).toEqual([]);
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
