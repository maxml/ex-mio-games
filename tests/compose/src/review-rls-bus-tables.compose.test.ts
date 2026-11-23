import { randomUUID } from 'node:crypto';
import type { Client } from 'pg';
import { pgAs, SERVICES } from './env';

/*
 * RLS gap review (2026-11-23), defect BUS-RLS: `outbox` and `inbox` hold tenant data and have no
 * row-level security, in every service database (packages/bus/src/sql.ts: "no RLS on purpose").
 * Every service connects with ONE runtime role, `<svc>_app`, for request paths, the relay and the
 * consumers alike (no separate worker role; the owner role runs migrate.js only). That role holds
 * SELECT, INSERT (and on outbox UPDATE) with no policy, so a tenant transaction of B
 * (`app.tenant_id` = B) reads and writes tenant A's rows. The only guard is in application code
 * (`enqueueEvent` OutboxTenantMismatchError), which raw SQL on the same connection does not pass.
 *
 * Exploit: any bug or injection in a tenant-B code path inserts an outbox row tagged tenant A,
 * e.g. `engagement.deposit.confirmed` in engagement or `audit.acting_request` towards identity.
 * The relay publishes it, and the consumer applies it inside tenant A's transaction (spins credited
 * to A's player, a forged entry in A's audit log). UPDATE on A's pending row marks it published, so
 * A's real event is dropped. SELECT reads A's envelopes (payloads, player ids, amounts).
 *
 * Same class as D-24 / D-32 F1 (audit_intents). Fix direction: tenant_id-keyed FORCE RLS on both
 * bus tables with the audit_intents policy (`tenant match OR (app.platform_scan AND no tenant)`),
 * the relay, outboxStats, unparkOutbox and the dlq CLI opting in through `platformTx({ scan: true })`,
 * keys led by tenant_id (ensureTenantKeys). Then drop `outbox`/`inbox` from GLOBAL_TABLES
 * (ledger.schema.pgtest.ts INV-L6) and BUS_TABLES (roles.compose.test.ts).
 * Mutation once green: remove FORCE or the policy from outbox/inbox -> red.
 *
 * Seeded rows are already `published_at` so the live relay never picks them up; every write by
 * the app role runs in a transaction that is rolled back.
 */
describe.each(SERVICES)('BUS-RLS: bus tables isolate tenants (%s)', (service) => {
  let admin: Client;
  let app: Client;
  const tenantA = randomUUID();
  const tenantB = randomUUID();
  const outboxId = randomUUID();
  const inboxId = randomUUID();
  const consumer = 'review-rls-probe';

  beforeAll(async () => {
    admin = await pgAs('postgres', service);
    app = await pgAs(`${service}_app`);
    await admin.query(
      `INSERT INTO "outbox" ("event_id", "tenant_id", "type", "envelope", "published_at")
       VALUES ($1, $2, 'review.rls.probe', $3, now())`,
      [
        outboxId,
        tenantA,
        JSON.stringify({ event_id: outboxId, tenant_id: tenantA, payload: { secret: 'A' } }),
      ],
    );
    await admin.query(
      `INSERT INTO "inbox" ("consumer", "event_id", "tenant_id") VALUES ($1, $2, $3)`,
      [consumer, inboxId, tenantA],
    );
  });
  afterAll(async () => {
    await admin?.query(`DELETE FROM "outbox" WHERE "event_id" = $1 OR "tenant_id" = $2`, [
      outboxId,
      tenantA,
    ]);
    await admin?.query(`DELETE FROM "inbox" WHERE "consumer" = $1`, [consumer]);
    await app?.end();
    await admin?.end();
  });

  /** Run `fn` as `<svc>_app` inside a transaction of tenant B, always rolled back. */
  async function asTenantB<T>(fn: () => Promise<T>): Promise<T> {
    await app.query('BEGIN');
    try {
      await app.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantB]);
      return await fn();
    } finally {
      await app.query('ROLLBACK');
    }
  }

  it('control: tenant A rows exist', async () => {
    const o = await admin.query(`SELECT count(*)::int AS n FROM "outbox" WHERE "event_id" = $1`, [
      outboxId,
    ]);
    const i = await admin.query(`SELECT count(*)::int AS n FROM "inbox" WHERE "event_id" = $1`, [
      inboxId,
    ]);
    expect([o.rows[0].n, i.rows[0].n]).toEqual([1, 1]);
  });

  // BUS-RLS defect: no policy on outbox, so B reads A's event envelopes.
  it('BUS-RLS-1 a tenant-B transaction cannot read tenant A outbox rows', async () => {
    const seen = await asTenantB(() =>
      app.query(`SELECT count(*)::int AS n FROM "outbox" WHERE "tenant_id" = $1`, [tenantA]),
    );
    expect({ service, visible: seen.rows[0].n }).toEqual({ service, visible: 0 });
  });

  // BUS-RLS defect: no WITH CHECK on outbox, so B enqueues an event the relay publishes as A's.
  it('BUS-RLS-2 a tenant-B transaction cannot enqueue an event for A', async () => {
    const forged = randomUUID();
    await expect(
      asTenantB(() =>
        app.query(
          `INSERT INTO "outbox" ("event_id", "tenant_id", "type", "envelope") VALUES ($1, $2, $3, $4)`,
          [
            forged,
            tenantA,
            'engagement.deposit.confirmed',
            JSON.stringify({ event_id: forged, tenant_id: tenantA }),
          ],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  // BUS-RLS defect: B updates A's row (could mark A's pending event published and drop it).
  it('BUS-RLS-3 a tenant-B transaction cannot update tenant A outbox rows', async () => {
    const res = await asTenantB(() =>
      app.query(`UPDATE "outbox" SET "last_error" = 'b was here' WHERE "event_id" = $1`, [
        outboxId,
      ]),
    );
    expect({ service, updated: res.rowCount }).toEqual({ service, updated: 0 });
  });

  // BUS-RLS defect: no policy on inbox, so B reads A's consumed event ids and activity volume.
  it('BUS-RLS-4 a tenant-B transaction cannot read tenant A inbox rows', async () => {
    const seen = await asTenantB(() =>
      app.query(`SELECT count(*)::int AS n FROM "inbox" WHERE "tenant_id" = $1`, [tenantA]),
    );
    expect({ service, visible: seen.rows[0].n }).toEqual({ service, visible: 0 });
  });

  // BUS-RLS defect: B writes a dedupe row tagged A, so A's event with that id is dropped as a duplicate.
  it('BUS-RLS-5 a tenant-B transaction cannot write a tenant A inbox row', async () => {
    await expect(
      asTenantB(() =>
        app.query(`INSERT INTO "inbox" ("consumer", "event_id", "tenant_id") VALUES ($1, $2, $3)`, [
          consumer,
          randomUUID(),
          tenantA,
        ]),
      ),
    ).rejects.toThrow(/row-level security/);
  });
});
