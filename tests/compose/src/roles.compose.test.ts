import type { Client } from 'pg';
import { pgAs } from './env';

/**
 * Review F2 (L3 Stage B). The engagement runtime role holds exactly these table privileges, written
 * out independently of the migrations that grant them, and every unique key of every tenant table
 * carries tenant_id. These are the lines the reconciled tests/compose/src/roles.compose.test.ts on
 * int/contracts takes for `EXPECTED_GRANTS.engagement` (the arrays are alphabetical: the query orders
 * by privilege_type). Column grants do not appear in table_privileges; `spin_credits(status, used_at)`
 * stays pinned by INV-ENGAGEMENT-SCHEMA-DB.
 *
 * Needs the compose stack (not run at Stage B for this reason).
 */
const EXPECTED_GRANTS_ENGAGEMENT: Record<string, string[]> = {
  inbound_events: ['INSERT', 'SELECT'],
  inbox: ['INSERT', 'SELECT'],
  outbox: ['INSERT', 'SELECT', 'UPDATE'],
  reward_tables: ['INSERT', 'SELECT'],
  rules: ['INSERT', 'SELECT'],
  spin_credits: ['INSERT', 'SELECT'],
  spins: ['INSERT', 'SELECT'],
  tenant_projections: ['INSERT', 'SELECT', 'UPDATE'],
};

/** The bus tables carry a tenant_id for diagnosis only and are read across tenants by design. */
const BUS_TABLES = ['outbox', 'inbox'];

describe('database roles: engagement', () => {
  let admin: Client;
  beforeAll(async () => {
    admin = await pgAs('postgres', 'engagement');
  });
  afterAll(async () => {
    await admin?.end();
  });

  it('INV-ENGAGEMENT-GRANTS-DB: engagement_app holds exactly the listed table privileges and nothing else', async () => {
    const { rows } = await admin.query(
      `SELECT table_name, privilege_type FROM information_schema.table_privileges
        WHERE grantee = 'engagement_app' AND table_schema = 'public' ORDER BY table_name, privilege_type`,
    );
    const actual: Record<string, string[]> = {};
    for (const r of rows) (actual[r.table_name] ??= []).push(r.privilege_type);
    expect(actual).toEqual(EXPECTED_GRANTS_ENGAGEMENT);
  });

  it('INV-ENGAGEMENT-TENANT-KEYS-DB: every unique key (primary keys included) of every tenant table carries tenant_id', async () => {
    const { rows: tables } = await admin.query(
      `SELECT c.relname FROM pg_class c
         JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped
        WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r' AND c.relname <> ALL($1)`,
      [BUS_TABLES],
    );
    expect(tables.map((t) => t.relname)).toEqual(
      expect.arrayContaining(['inbound_events', 'spin_credits', 'spins']),
    );
    for (const t of tables) {
      const { rows: keys } = await admin.query(
        `SELECT ic.relname AS index_name, bool_or(a.attname = 'tenant_id') AS has_tenant
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
