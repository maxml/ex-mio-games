import type { DataSource, EntityManager } from 'typeorm';
import { uuidv7, type EventEnvelope } from '@ex-mio/contracts';
import { Db } from '@ex-mio/service-kit';
import { createDataSource } from '@ex-mio/service-kit';
import { TenantProjectionEntity } from '../model/tenant-projection.entity';
import { PgRedemptionStore } from '../model/redemption.store';
import { TestClock } from './testing/clock';
import type { StoreHarness } from './testing/store-conformance';
import { stageBConformance } from './testing/stage-b-conformance';

/*
 * Stage B fix-round contract (F2, F3, F5) against Postgres as the `engagement` role, same setup as
 * redemption-store.pg.itest.ts (copied: that file is frozen). Run it TWICE on one database: it must
 * stay green (F3: fixed event ids, fresh tenants). `pnpm --filter @ex-mio/engagement test:pg`.
 */
if (!process.env.DATABASE_URL)
  throw new Error('DATABASE_URL is required for the Postgres store contract run');

let dataSource: Promise<DataSource> | undefined;
const shared = (): Promise<DataSource> => {
  dataSource ??= (async () => {
    // rc review: as in redemption-store.pg.itest.ts (no migrations as the app role, no glob that
    // pulls a test file into a running test).
    return createDataSource({ entities: [TenantProjectionEntity], migrations: [] }).initialize();
  })();
  return dataSource;
};

afterAll(async () => {
  if (dataSource) await (await dataSource).destroy();
});

async function harness(ds: DataSource, clock: TestClock): Promise<StoreHarness> {
  const tenantId = uuidv7();
  const otherTenantId = uuidv7();
  const inTenant = <T>(fn: (m: EntityManager) => Promise<T>): Promise<T> =>
    ds.transaction(async (m) => {
      await m.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);
      return fn(m);
    });
  return {
    store: new PgRedemptionStore(new Db(ds), clock),
    clock,
    tenantId,
    otherTenantId,
    addItem: (o) =>
      inTenant(async (m) => {
        const id = uuidv7();
        await m.query(
          `INSERT INTO store_items (id, tenant_id, version, name, description, price, reward, stock, per_player_limit, active)
           VALUES ($1, $2, 1, 'item', '', $3, $4, $5, $6, true)`,
          [
            id,
            tenantId,
            o.price,
            JSON.stringify({ type: 'free_spins', params: { count: 10 } }),
            o.stock ?? null,
            o.perPlayerLimit ?? null,
          ],
        );
        return id;
      }),
    editItem: async () => {},
    deactivate: async () => {},
    stockOf: (id) =>
      inTenant(async (m) => {
        const rows: { stock: number | null }[] = await m.query(
          `SELECT stock FROM store_items WHERE id = $1`,
          [id],
        );
        return rows[0]?.stock ?? null;
      }),
    outbox: async (tenant) => {
      // The outbox is FORCE RLS: read it in the tenant's own transaction.
      const rows: { envelope: EventEnvelope }[] = await ds.transaction(async (m) => {
        await m.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenant]);
        return m.query(
          `SELECT envelope FROM outbox WHERE tenant_id = $1 ORDER BY created_at, event_id`,
          [tenant],
        );
      });
      return rows.map((r) => r.envelope);
    },
  };
}

stageBConformance('postgres', async () => {
  const ds = await shared();
  const clock = new TestClock();
  return [await harness(ds, clock), await harness(ds, clock)];
});

/*
 * Flaky F5 (review/flaky-f5-d16): this suite shares the database with a live stack whose engagement
 * worker claims work-queue rows due by the REAL clock. A test order that is due for it gets claimed,
 * rejected for funds and its stock restored mid-test (F5 read 89 for 88). Pinned where the due time
 * is written, so a store that dated the queue row by the database clock is caught too.
 * Mutations (each red): the TestClock default back to 2026-11-22T10:00Z; `next_attempt_at` from
 * `now()` in SQL instead of the injected clock.
 */
describe('a test order is never due for a worker on the real clock', () => {
  it('the work-queue row of a production order placed with the default TestClock is due after the real now', async () => {
    const ds = await shared();
    const h = await harness(ds, new TestClock());
    const itemId = await h.addItem({ price: 10, stock: 5, perPlayerLimit: null });
    const { redemption } = await h.store.placeOrder(
      { tenantId: h.tenantId, playerId: uuidv7(), sandbox: false },
      { operationKey: 'due-probe', itemId },
    );
    const rows: { next_attempt_at: Date | null }[] = await ds.transaction(async (m) => {
      await m.query(`SELECT set_config('app.tenant_id', $1, true)`, [h.tenantId]);
      return m.query(`SELECT next_attempt_at FROM redemption_work_queue WHERE redemption_id = $1`, [
        redemption.id,
      ]);
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.next_attempt_at).not.toBeNull();
    // A day of margin covers any skew between this process and the worker's clock.
    expect(rows[0]!.next_attempt_at!.getTime()).toBeGreaterThan(Date.now() + 24 * 3600 * 1000);
  });
});
