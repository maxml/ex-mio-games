import { randomUUID } from 'node:crypto';
import type { Client } from 'pg';
import { pgAs, SERVICES } from './env';

/*
 * Fix-round re-review, coordinator question 11 (D-24: every table that holds tenant data has FORCE
 * RLS, work queues included; a global table is allow-listed WITH a reason). `audit_intents`
 * (service-kit createAuditIntentsTable, in all three service DBs) holds full audit envelopes: the
 * target tenant, the acting admin or calling service, the route and the request id. It has no
 * `tenant_id` column, so roles.compose.test.ts (which only scans tables WITH that column) never
 * sees it, and no RLS. payments' ledger.schema.pgtest (which scans every table) went red on it.
 *
 * AI-RLS-1 (behaviour, RED expected at dd9d464): as `<svc>_app` with `app.tenant_id` = tenant B,
 *   an intent that names tenant A is invisible. Today the app role reads every tenant's intents.
 * AI-RLS-2 (schema, RED expected): every public table in every service DB is RLS-enabled AND
 *   forced, or is on the reasoned allow-list below; the scan does NOT depend on a column named
 *   `tenant_id` (that dependency is how audit_intents escaped).
 * Mutation after the fix: drop FORCE (or the policy) from audit_intents -> both red.
 * NOT RUN by the reviewer (compose-only). Run: the compose test target, this file.
 */

/** Tables that are global on purpose, per DB, with the reason. Everything else must be RLS-forced. */
const GLOBAL: Record<string, Record<string, string>> = {
  identity: {
    migrations: 'TypeORM bookkeeping',
    outbox: 'bus table (D-11): relayed by the platform relay',
    inbox: 'bus table: consumer dedupe by event id',
    tenants: 'the tenant registry itself; its id is the tenant',
    signing_keys: 'platform signing keys, no tenant',
  },
  engagement: {
    migrations: 'TypeORM bookkeeping',
    outbox: 'bus table',
    inbox: 'bus table',
  },
  payments: {
    migrations: 'TypeORM bookkeeping',
    outbox: 'bus table',
    inbox: 'bus table',
    billing_plans: 'the plan catalogue, no tenant (ledger.schema.pgtest GLOBAL_TABLES)',
    reconciliation_tenants: 'id-only registry (roles.compose PLATFORM_TABLES)',
  },
};

describe.each(SERVICES)('fix-round re-review: audit_intents isolation in %s (Q11)', (service) => {
  let admin: Client;
  let app: Client;
  beforeAll(async () => {
    admin = await pgAs('postgres', service);
    app = await pgAs(`${service}_app`);
  });
  afterAll(async () => {
    await app?.end();
    await admin?.end();
  });

  it('AI-RLS-1 tenant B cannot read an audit intent that names tenant A', async () => {
    const tenantA = randomUUID();
    const tenantB = randomUUID();
    const id = randomUUID();
    await admin.query(`INSERT INTO "audit_intents" ("event_id", "envelope") VALUES ($1, $2)`, [
      id,
      JSON.stringify({ event_id: id, tenant_id: tenantA, payload: { route: 'x' } }),
    ]);
    try {
      // the control: the row is there
      const all = await admin.query(
        `SELECT count(*)::int AS n FROM "audit_intents" WHERE event_id = $1`,
        [id],
      );
      expect(all.rows[0].n).toBe(1);
      await app.query('BEGIN');
      await app.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantB]);
      const seen = await app.query(
        `SELECT count(*)::int AS n FROM "audit_intents" WHERE event_id = $1`,
        [id],
      );
      await app.query('ROLLBACK');
      expect({ service, visibleToTenantB: seen.rows[0].n }).toEqual({
        service,
        visibleToTenantB: 0,
      });
    } finally {
      await admin.query(`DELETE FROM "audit_intents" WHERE event_id = $1`, [id]);
    }
  });

  it('AI-RLS-2 every table is RLS-forced or allow-listed with a reason (no tenant_id-column shortcut)', async () => {
    const { rows } = await admin.query(
      `SELECT c.relname AS t FROM pg_class c
        WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r','p')
          AND NOT (c.relrowsecurity AND c.relforcerowsecurity)
        ORDER BY 1`,
    );
    const unprotected = rows.map((r) => r.t as string).filter((t) => !(t in GLOBAL[service]!));
    expect({ service, unprotected }).toEqual({ service, unprotected: [] });
  });
});
