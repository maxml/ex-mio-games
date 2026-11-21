import type { EntityManager } from 'typeorm';
import { uuidv7, type EventEnvelope } from '@ex-mio/contracts';
import { Db } from '@ex-mio/service-kit';
import { makeDataSource } from '../model/data-source';
import { PgRedemptionStore } from '../model/redemption.store';
import { storeConformance } from './testing/store-conformance';

/*
 * The RedemptionStore contract against the real Postgres store, as the `engagement` service role
 * (not a superuser, RLS forced). Not part of the unit run: needs the compose Postgres.
 *   DATABASE_URL=postgresql://engagement:engagement-dev@localhost:54329/engagement \
 *     npx jest --maxWorkers=1 --testMatch '**\/*.itest.ts'
 * RED today: ../model/redemption.store does not exist. Mutations are listed in store-conformance.ts.
 * The harness writes through the real tables named in the spec (§5), under the tenant's RLS context.
 */
if (!process.env.DATABASE_URL)
  throw new Error('DATABASE_URL is required for the Postgres store contract run');

storeConformance('postgres', async () => {
  const ds = await makeDataSource().initialize();
  await ds.runMigrations();
  const tenantId = uuidv7();
  const otherTenantId = uuidv7();
  const inTenant = <T>(fn: (m: EntityManager) => Promise<T>): Promise<T> =>
    ds.transaction(async (m) => {
      await m.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);
      return fn(m);
    });
  return {
    store: new PgRedemptionStore(new Db(ds)),
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
      const rows: { envelope: EventEnvelope }[] = await ds.query(
        `SELECT envelope FROM outbox WHERE tenant_id = $1 ORDER BY created_at, event_id`,
        [tenant],
      );
      return rows.map((r) => r.envelope);
    },
  };
});
