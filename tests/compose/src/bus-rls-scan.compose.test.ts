import { randomUUID } from 'node:crypto';
import type { Client } from 'pg';
import { pgAs, SERVICES } from './env';

/*
 * The platform branch of the bus-table policy (migration 1733300000000-BusTablesTenantRls), raw SQL as
 * `<svc>_app`: a transaction with NO tenant set sees and writes nothing unless it opts in with
 * `app.platform_scan`, and a tenant transaction never gets the scan branch, whatever else it sets.
 * Mutation: change the policy to `tenant match OR no tenant` -> BUS-SCAN-1 and BUS-SCAN-2 go red.
 * Mutation: drop the `NO_TENANT` half of the scan branch -> BUS-SCAN-3 goes red.
 * Mutation: remove ENABLE/FORCE or the policy -> BUS-RLS-1..5 and BUS-SCAN-1..3 go red / roles scan red.
 * Seeded rows are already `published_at` so the live relay never takes them; every app-role write is rolled back.
 */
describe.each(SERVICES)('BUS-SCAN: the platform branch of the bus policy (%s)', (service) => {
  let admin: Client;
  let app: Client;
  const tenantA = randomUUID();
  const tenantB = randomUUID();
  const outboxId = randomUUID();
  const inboxId = randomUUID();
  const consumer = 'review-scan-probe';

  beforeAll(async () => {
    admin = await pgAs('postgres', service);
    app = await pgAs(`${service}_app`);
    await admin.query(
      `INSERT INTO "outbox" ("event_id", "tenant_id", "type", "envelope", "published_at")
       VALUES ($1, $2, 'review.scan.probe', $3, now())`,
      [outboxId, tenantA, JSON.stringify({ event_id: outboxId, tenant_id: tenantA })],
    );
    await admin.query(
      `INSERT INTO "inbox" ("consumer", "event_id", "tenant_id") VALUES ($1, $2, $3)`,
      [consumer, inboxId, tenantA],
    );
  });
  afterAll(async () => {
    await admin?.query(`DELETE FROM "outbox" WHERE "event_id" = $1`, [outboxId]);
    await admin?.query(`DELETE FROM "inbox" WHERE "consumer" = $1`, [consumer]);
    await app?.end();
    await admin?.end();
  });

  async function inTx<T>(settings: Record<string, string>, fn: () => Promise<T>): Promise<T> {
    await app.query('BEGIN');
    try {
      for (const [k, v] of Object.entries(settings)) {
        await app.query(`SELECT set_config($1, $2, true)`, [k, v]);
      }
      return await fn();
    } finally {
      await app.query('ROLLBACK');
    }
  }
  const count = (table: string) =>
    app
      .query(`SELECT count(*)::int AS n FROM "${table}" WHERE "tenant_id" = $1`, [tenantA])
      .then((r) => r.rows[0].n as number);

  it('BUS-SCAN-1 no tenant and no scan flag: no rows of either bus table', async () => {
    const seen = await inTx({}, async () => [await count('outbox'), await count('inbox')]);
    expect({ service, seen }).toEqual({ service, seen: [0, 0] });
  });

  it('BUS-SCAN-2 no tenant and no scan flag: an insert is rejected by row-level security', async () => {
    await expect(
      inTx({}, () =>
        app.query(
          `INSERT INTO "outbox" ("event_id", "tenant_id", "type", "envelope") VALUES ($1, $2, 'x', '{}')`,
          [randomUUID(), tenantA],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it('BUS-SCAN-3 a tenant transaction that also sets the scan flag still sees only its own rows', async () => {
    const seen = await inTx({ 'app.tenant_id': tenantB, 'app.platform_scan': 'on' }, async () => [
      await count('outbox'),
      await count('inbox'),
    ]);
    expect({ service, seen }).toEqual({ service, seen: [0, 0] });
  });

  it('BUS-SCAN-4 control: the scan flag with no tenant sees the rows (the relay path works)', async () => {
    const seen = await inTx({ 'app.platform_scan': 'on' }, async () => [
      await count('outbox'),
      await count('inbox'),
    ]);
    expect({ service, seen }).toEqual({ service, seen: [1, 1] });
  });
});
