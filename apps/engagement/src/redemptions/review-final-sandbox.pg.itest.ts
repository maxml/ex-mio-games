import type { DataSource, EntityManager } from 'typeorm';
import { uuidv7, type EventEnvelope } from '@ex-mio/contracts';
import { createDataSource, Db } from '@ex-mio/service-kit';
import { TenantProjectionEntity } from '../model/tenant-projection.entity';
import { PgRedemptionStore } from '../model/redemption.store';
import { TestClock } from './testing/clock';
import { sandboxStockConformance } from './testing/review-final-sandbox-conformance';

/*
 * Final review: the D-28 sandbox stock suite against Postgres, as `engagement_app`, on a database
 * the stack's migrate step already migrated (same setup as redemption-store.stageb.pg.itest.ts).
 * Compose-only: `pnpm --filter @ex-mio/engagement test:pg`.
 */
if (!process.env.DATABASE_URL)
  throw new Error('DATABASE_URL is required for the Postgres store contract run');

let dataSource: Promise<DataSource> | undefined;
const shared = (): Promise<DataSource> => {
  dataSource ??= createDataSource({
    entities: [TenantProjectionEntity],
    migrations: [],
  }).initialize();
  return dataSource;
};

afterAll(async () => {
  if (dataSource) await (await dataSource).destroy();
});

sandboxStockConformance('postgres', async () => {
  const ds = await shared();
  const clock = new TestClock();
  const tenantId = uuidv7();
  const inTenant = <T>(fn: (m: EntityManager) => Promise<T>): Promise<T> =>
    ds.transaction(async (m) => {
      await m.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);
      return fn(m);
    });
  return {
    store: new PgRedemptionStore(new Db(ds), clock),
    clock,
    tenantId,
    otherTenantId: uuidv7(),
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
});
