import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { addAuditIntentsTenantRls, createAuditIntentsTable } from './audit-intents';

/*
 * Fix round 2 re-review, R1 (D-24, D-31): `audit_intents` got `tenant_id` and ENABLE + FORCE RLS
 * through `addAuditIntentsTenantRls`, the choke point every service migration calls. This runs that
 * function against a real Postgres and checks the policy as the runtime role sees it (SET ROLE to a
 * role without BYPASSRLS), in a schema of its own that is dropped afterwards.
 *
 * Needs `REVIEW_PG_URL` (a superuser URL of a throwaway Postgres); without it the suite is skipped
 * and says so. The compose twin, on the real migrated databases, is AI-RLS-3 in
 * tests/compose/src/review-fixround-audit-intents-rls.compose.test.ts.
 *
 * FR2-AI-1 (green): a tenant transaction never sees another tenant's intent.
 * FR2-AI-2 (RED at 6298275): a connection that set NO tenant and no platform opt-in sees no intent.
 *   That is the default of every other tenant table (packages/tenancy/src/rls.ts: "no setting means
 *   no rows"); the audit_intents policy reads `tenant OR no tenant`, so the default context reads
 *   every tenant's in-flight acting envelopes. The work queue (WorkQueueScanNoTenant) shows the
 *   project's own fix: a narrow opt-in flag AND no tenant, WITH CHECK tenant-only.
 *   Mutation check (reviewer, re-applied): policy `USING (tenant)` only -> green.
 * FR2-AI-3 (green): the backfill takes each existing row's tenant from its envelope, and those rows
 *   are isolated afterwards. Mutation: backfill from a constant tenant -> red.
 * FR2-SCAN-1 (green): the AI-RLS-2 scan query (no tenant_id-column shortcut) reports a tenant table
 *   that has NO tenant_id column and no RLS, and reports audit_intents once FORCE is dropped.
 */

const url = process.env.REVIEW_PG_URL;
const run = url ? describe : describe.skip;
if (!url) {
  // A skipped suite must be visible in the output, not silently green.
  // eslint-disable-next-line no-console
  console.warn('review-fr2-audit-intents-rls: REVIEW_PG_URL not set, suite skipped');
}

const SCHEMA = `fr2_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
const APP = `${SCHEMA}_app`;

run('fix round 2: audit_intents tenant RLS at the choke point (R1)', () => {
  let pg: Client;
  const A = randomUUID();
  const B = randomUUID();

  const asApp = async <T>(fn: () => Promise<T>, tenant?: string): Promise<T> => {
    await pg.query('BEGIN');
    try {
      await pg.query(`SET LOCAL ROLE "${APP}"`);
      if (tenant !== undefined)
        await pg.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenant]);
      return await fn();
    } finally {
      await pg.query('ROLLBACK');
    }
  };
  const count = async (): Promise<number> =>
    (await pg.query(`SELECT count(*)::int AS n FROM "audit_intents"`)).rows[0].n as number;
  const insertRaw = (tenant: string) =>
    pg.query(`INSERT INTO "audit_intents" ("event_id", "envelope") VALUES ($1, $2)`, [
      randomUUID(),
      JSON.stringify({ tenant_id: tenant, payload: { route: 'PUT /v1/operator/wheel' } }),
    ]);

  beforeAll(async () => {
    pg = new Client({ connectionString: url });
    await pg.connect();
    await pg.query(`CREATE SCHEMA "${SCHEMA}"`);
    await pg.query(`SET search_path = "${SCHEMA}"`);
    await pg.query(`CREATE ROLE "${APP}" NOLOGIN NOBYPASSRLS`);
    await pg.query(`GRANT USAGE ON SCHEMA "${SCHEMA}" TO "${APP}"`);
    await createAuditIntentsTable(pg);
    // rows written by the previous release, before the forward migration
    await insertRaw(A);
    await insertRaw(B);
    await addAuditIntentsTenantRls(pg);
    await pg.query(`GRANT SELECT, INSERT, DELETE ON "audit_intents" TO "${APP}"`);
    await insertRaw(A); // a row written after the migration (the trigger fills tenant_id)
  });

  afterAll(async () => {
    await pg.query(`DROP SCHEMA "${SCHEMA}" CASCADE`);
    await pg.query(`DROP ROLE "${APP}"`);
    await pg.end();
  });

  it('FR2-AI-0 control: the owner sees the three rows', async () => {
    expect(await count()).toBe(3);
  });

  it('FR2-AI-1 a tenant transaction sees only its own intents', async () => {
    expect(await asApp(count, A)).toBe(2);
    expect(await asApp(count, B)).toBe(1);
  });

  it('FR2-AI-2 a connection with no tenant and no platform opt-in sees no intent (default deny)', async () => {
    expect({ visibleWithoutTenant: await asApp(count) }).toEqual({ visibleWithoutTenant: 0 });
  });

  it('FR2-AI-3 the backfill takes each existing row tenant from its envelope', async () => {
    const { rows } = await pg.query(
      `SELECT ("envelope"->>'tenant_id')::uuid = "tenant_id" AS same FROM "audit_intents"`,
    );
    expect(rows.map((r) => r.same)).toEqual([true, true, true]);
  });

  it('FR2-SCAN-1 the AI-RLS-2 scan sees a tenant table without a tenant_id column, and audit_intents without FORCE', async () => {
    const scan = async (): Promise<string[]> =>
      (
        await pg.query(
          `SELECT c.relname AS t FROM pg_class c
            WHERE c.relnamespace = $1::regnamespace AND c.relkind IN ('r','p')
              AND NOT (c.relrowsecurity AND c.relforcerowsecurity)
            ORDER BY 1`,
          [SCHEMA],
        )
      ).rows.map((r) => r.t as string);
    expect(await scan()).toEqual([]); // the control: audit_intents is protected
    await pg.query(`CREATE TABLE "player_notes" ("owner" uuid, "note" text)`); // no tenant_id column
    expect(await scan()).toEqual(['player_notes']);
    await pg.query(`ALTER TABLE "audit_intents" NO FORCE ROW LEVEL SECURITY`);
    try {
      expect(await scan()).toEqual(['audit_intents', 'player_notes']);
    } finally {
      await pg.query(`ALTER TABLE "audit_intents" FORCE ROW LEVEL SECURITY`);
      await pg.query(`DROP TABLE "player_notes"`);
    }
  });
});
