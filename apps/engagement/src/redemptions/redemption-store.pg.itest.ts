import type { DataSource, EntityManager } from 'typeorm';
import { uuidv7, type EventEnvelope } from '@ex-mio/contracts';
import { Db } from '@ex-mio/service-kit';
import { createDataSource } from '@ex-mio/service-kit';
import { TenantProjectionEntity } from '../model/tenant-projection.entity';
import { PgRedemptionStore } from '../model/redemption.store';
import { TestClock } from './testing/clock';
import { storeConformance } from './testing/store-conformance';

/*
 * The RedemptionStore contract against the real Postgres store, as the `engagement` service role
 * (not a superuser, RLS forced): the SAME `storeConformance` function the in-memory fake passes.
 * Needs the compose Postgres (only postgres, under the compose lock):
 *   DATABASE_URL=postgresql://engagement:engagement-dev@localhost:54329/engagement \
 *     pnpm --filter @ex-mio/engagement test:pg
 * CI runs the same script in the `compose` job, after the stack is healthy.
 * Was red when written: ../model/redemption.store does not exist. Mutations are listed in store-conformance.ts.
 * The harness writes through the real tables named in the spec (§5), under the tenant's RLS context.
 * One DataSource for the whole file, destroyed in afterAll (no leaked pools, no --forceExit).
 * Every test uses fresh tenant ids, so the shared database needs no cleanup between tests.
 */
if (!process.env.DATABASE_URL)
  throw new Error('DATABASE_URL is required for the Postgres store contract run');

let dataSource: Promise<DataSource> | undefined;
const shared = (): Promise<DataSource> => {
  dataSource ??= (async () => {
    // rc review: the runtime role owns nothing (D-12), so it cannot run migrations (it failed with
    // "permission denied for schema public" and leaked the pool); the stack's migrate step applies
    // them as the owner. The app connection loads no migration files: the `migrations/*.ts` glob
    // also matched `ingest-schema.test.ts`, which jest then refused to nest inside a running test.
    return createDataSource({ entities: [TenantProjectionEntity], migrations: [] }).initialize();
  })();
  return dataSource;
};

afterAll(async () => {
  if (dataSource) await (await dataSource).destroy();
});

storeConformance('postgres', async () => {
  const ds = await shared();
  const clock = new TestClock();
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
    editItem: (id, patch) =>
      inTenant(async (m) => {
        await m.query(
          `UPDATE store_items SET version = version + 1,
             price = COALESCE($2, price),
             reward = COALESCE($3::jsonb, reward) WHERE id = $1`,
          [
            id,
            patch.price ?? null,
            patch.rewardType ? JSON.stringify({ type: patch.rewardType, params: {} }) : null,
          ],
        );
      }),
    deactivate: (id) =>
      inTenant(async (m) => {
        await m.query(`UPDATE store_items SET active = false WHERE id = $1`, [id]);
      }),
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
