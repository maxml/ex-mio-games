import { randomUUID } from 'node:crypto';
import type { Client } from 'pg';
import { pgAs, SERVICES } from './env';

/*
 * Fix round 2 re-review, R1 residue (D-24, D-31). AI-RLS-1/2 (review-fixround-audit-intents-rls)
 * are green after 964d192: a tenant transaction no longer sees another tenant's intent, and the
 * table is ENABLE + FORCE. What the fix moved: the policy reads `tenant OR no tenant`, so a
 * connection of `<svc>_app` that set NO tenant (a platformTx, a bare dataSource.query, a code path
 * that forgot tenantTx) reads every tenant's in-flight acting envelopes. Every other tenant table
 * answers such a connection with no rows (packages/tenancy/src/rls.ts), and the one other platform
 * reader, the redemption work queue, needs an explicit opt-in flag AND no tenant
 * (WorkQueueScanNoTenant1732700000000), with WITH CHECK tenant-only.
 *
 * AI-RLS-3 (RED at 6298275): as `<svc>_app` with nothing set, an intent of tenant A is invisible.
 * Verified against a local Postgres 17 by packages/service-kit/src/review-fr2-audit-intents-rls.test.ts
 * FR2-AI-2 (3 of 3 rows visible today). The audit port, finalize and the sweeper must then opt in
 * explicitly, the way the work-queue sweeper does.
 * Mutation after a fix: put `OR <no tenant>` back into the USING clause -> red.
 * NOT RUN by the reviewer (compose-only).
 */
describe.each(SERVICES)(
  'fix round 2: audit_intents denies a connection without a tenant (%s)',
  (service) => {
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

    it('AI-RLS-3 a connection with no tenant and no platform opt-in sees no intent', async () => {
      const tenantA = randomUUID();
      const id = randomUUID();
      await admin.query(`INSERT INTO "audit_intents" ("event_id", "envelope") VALUES ($1, $2)`, [
        id,
        JSON.stringify({ event_id: id, tenant_id: tenantA, payload: { route: 'x' } }),
      ]);
      try {
        const control = await admin.query(
          `SELECT count(*)::int AS n FROM "audit_intents" WHERE event_id = $1`,
          [id],
        );
        expect(control.rows[0].n).toBe(1);
        await app.query('BEGIN');
        const seen = await app.query(
          `SELECT count(*)::int AS n FROM "audit_intents" WHERE event_id = $1`,
          [id],
        );
        await app.query('ROLLBACK');
        expect({ service, visibleWithoutTenant: seen.rows[0].n }).toEqual({
          service,
          visibleWithoutTenant: 0,
        });
      } finally {
        await admin.query(`DELETE FROM "audit_intents" WHERE event_id = $1`, [id]);
      }
    });
  },
);
