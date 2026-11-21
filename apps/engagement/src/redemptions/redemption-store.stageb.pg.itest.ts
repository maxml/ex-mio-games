import type { DataSource, EntityManager } from 'typeorm';
import { uuidv7, type EventEnvelope } from '@ex-mio/contracts';
import { Db } from '@ex-mio/service-kit';
import { makeDataSource } from '../model/data-source';
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
    const ds = await makeDataSource().initialize();
    await ds.runMigrations();
    return ds;
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
      const rows: { envelope: EventEnvelope }[] = await ds.query(
        `SELECT envelope FROM outbox WHERE tenant_id = $1 ORDER BY created_at, event_id`,
        [tenant],
      );
      return rows.map((r) => r.envelope);
    },
  };
}

stageBConformance('postgres', async () => {
  const ds = await shared();
  const clock = new TestClock();
  return [await harness(ds, clock), await harness(ds, clock)];
});
