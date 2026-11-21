import { uuidv7 } from '@ex-mio/contracts';
import { pgAs, urls } from './env';

/*
 * Store and redemption API against the live stack (real Postgres, RLS, the real HTTP layer).
 * RED today: the engagement service has no /v1/store or /v1/redemptions routes (404).
 * Spec: docs/specs/engagement-store.md §7. Run: `pnpm test:compose` with the stack up.
 */

const tenantA = uuidv7();
const tenantB = uuidv7();
const hdr = (
  tenant: string,
  principal: string,
  role = 'player',
  extra: Record<string, string> = {},
) => ({
  'content-type': 'application/json',
  'x-tenant-id': tenant,
  'x-principal-id': principal,
  'x-principal-role': role,
  ...extra,
});

const createItem = async (tenant: string, body: Record<string, unknown>) => {
  const res = await fetch(`${urls.engagement}/v1/store/items`, {
    method: 'POST',
    headers: hdr(tenant, 'op-1', 'admin'),
    body: JSON.stringify({
      name: 'Spins',
      price: 10,
      reward: { type: 'free_spins', params: { count: 10 } },
      ...body,
    }),
  });
  expect(res.status).toBe(201);
  return (await res.json()) as { id: string };
};

const redeem = (tenant: string, player: string, itemId: string, key: string, extra = {}) =>
  fetch(`${urls.engagement}/v1/redemptions`, {
    method: 'POST',
    headers: { ...hdr(tenant, player, 'player', extra), 'idempotency-key': key },
    body: JSON.stringify({ item_id: itemId }),
  });

describe('bonus store (engagement) against real Postgres', () => {
  // Mutation: replace the conditional stock UPDATE with read-then-write -> more than 7 wins.
  it('I-ORDER-2/AC-065 stock never goes below zero under 50 parallel reservations', async () => {
    const item = await createItem(tenantA, { stock: 7 });
    const res = await Promise.all(
      Array.from({ length: 50 }, (_, i) => redeem(tenantA, `p${i}`, item.id, `key-${uuidv7()}`)),
    );
    const bodies = await Promise.all(res.map(async (r) => ({ s: r.status, b: await r.json() })));
    expect(bodies.filter((x) => x.s === 202)).toHaveLength(7);
    for (const x of bodies.filter((y) => y.s !== 202)) {
      expect(x.s).toBe(409);
      expect(x.b.code).toBe('out_of_stock');
    }
  });

  // Mutation: drop the unique (tenant, player, operation key) constraint / dedupe lookup.
  it('I-ORDER-1/MIO-142 the same key sent 10 times in parallel -> one redemption', async () => {
    const item = await createItem(tenantA, { stock: 5 });
    const key = `key-${uuidv7()}`;
    const res = await Promise.all(
      Array.from({ length: 10 }, () => redeem(tenantA, 'p1', item.id, key)),
    );
    const ok = res.filter((r) => r.status === 202);
    expect(ok.length).toBeGreaterThan(0);
    for (const r of res.filter((x) => x.status !== 202)) expect(r.status).toBe(409);
    const ids = new Set(
      await Promise.all(ok.map(async (r) => ((await r.json()) as { id: string }).id)),
    );
    expect(ids.size).toBe(1);
  });

  it('I-ORDER-1b the same key with a different item is 422 idempotency_key_reused', async () => {
    const i1 = await createItem(tenantA, { stock: 5 });
    const i2 = await createItem(tenantA, { stock: 5 });
    const key = `key-${uuidv7()}`;
    expect((await redeem(tenantA, 'p1', i1.id, key)).status).toBe(202);
    const res = await redeem(tenantA, 'p1', i2.id, key);
    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe('idempotency_key_reused');
  });

  // Mutation: look up by id alone, or drop the RLS policy on redemptions.
  it("I-OWN-1 player B cannot read A's redemption; another tenant cannot either; a sandbox player cannot", async () => {
    const item = await createItem(tenantA, { stock: 5 });
    const created = await redeem(tenantA, 'alice', item.id, `key-${uuidv7()}`);
    const { id } = (await created.json()) as { id: string };
    const get = (tenant: string, principal: string, extra = {}) =>
      fetch(`${urls.engagement}/v1/redemptions/${id}`, {
        headers: hdr(tenant, principal, 'player', extra),
      });
    expect((await get(tenantA, 'alice')).status).toBe(200);
    expect((await get(tenantA, 'bob')).status).toBe(404);
    expect((await get(tenantB, 'alice')).status).toBe(404);
    expect((await get(tenantA, 'alice', { 'x-sandbox': '1' })).status).toBe(404);
  });

  it('I-ISO-1 a tenant sees only its own items', async () => {
    const mine = await createItem(tenantA, { stock: 1 });
    const res = await fetch(`${urls.engagement}/v1/store/items`, { headers: hdr(tenantB, 'p1') });
    expect(res.status).toBe(200);
    const list = (await res.json()) as { id: string }[];
    expect(list.map((i) => i.id)).not.toContain(mine.id);
  });

  // Mutation: grant BYPASSRLS to the service role, or create the tables without FORCE RLS.
  it('I-ISO-2 the service role itself reads no store rows without a tenant', async () => {
    const db = await pgAs('engagement');
    try {
      // (`redemption_work_queue` is intentionally RLS-free: ids and times only.)
      for (const table of ['store_items', 'redemptions', 'redemption_history']) {
        const { rows } = await db.query(`SELECT count(*)::int AS n FROM ${table}`);
        expect(rows[0].n).toBe(0);
      }
    } finally {
      await db.end();
    }
  });

  it('I-OWN-2 a redemption row exists only for the tenant that created it (checked with the tenant set)', async () => {
    const item = await createItem(tenantA, { stock: 5 });
    const created = await redeem(tenantA, 'alice', item.id, `key-${uuidv7()}`);
    const { id } = (await created.json()) as { id: string };
    const db = await pgAs('engagement');
    try {
      await db.query('BEGIN');
      await db.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantB]);
      expect((await db.query('SELECT 1 FROM redemptions WHERE id = $1', [id])).rowCount).toBe(0);
      await db.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantA]);
      const row = await db.query('SELECT price, state, sandbox FROM redemptions WHERE id = $1', [
        id,
      ]);
      expect(row.rows[0]).toMatchObject({ price: 10, state: 'REQUESTED', sandbox: false });
      await db.query('ROLLBACK');
    } finally {
      await db.end();
    }
  });
});
