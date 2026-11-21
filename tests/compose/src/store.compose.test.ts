import { uuidv7 } from '@ex-mio/contracts';
import { pgAs, urls } from './env';
import { newTenant, type PlayerSession, type TestTenant } from './player-session';
import { seedCoins, seedCoinsMany } from './seed-coins';

/*
 * Store and redemption API against the live stack (real Postgres, RLS, the real HTTP layer).
 * RED today: the engagement service has no /v1/store or /v1/redemptions routes (404).
 * Spec: docs/specs/engagement-store.md §7. Run: `pnpm test:compose` with the stack up.
 *
 * Authentication is real everywhere (D-4, D-12, X-9): operators and players are created through
 * identity (`player-session.ts`, real signup, login and casino launch) and every request carries
 * their JWT. There is no `x-tenant-id`, `x-principal-*` or `x-sandbox` header. Players get coins the
 * way a real player does (reconciliation section 3): `seed-coins.ts` publishes the
 * `engagement.spin.completed` a spin would write, and payments credits it through its inbox. There
 * is no credit route to call.
 */

let tenantA: TestTenant;
let tenantB: TestTenant;
let operatorA: Record<string, string>;
let operatorPaymentsA: string;

beforeAll(async () => {
  tenantA = await newTenant();
  tenantB = await newTenant();
  operatorA = await tenantA.operatorHeaders('engagement');
  operatorPaymentsA = await tenantA.operatorToken('payments');
});

const json = { 'content-type': 'application/json' };

const createItem = async (body: Record<string, unknown>) => {
  const res = await fetch(`${urls.engagement}/v1/store/items`, {
    method: 'POST',
    headers: { ...json, ...operatorA },
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

const redeem = (player: PlayerSession, itemId: string, key: string) =>
  fetch(`${urls.engagement}/v1/redemptions`, {
    method: 'POST',
    headers: { ...json, ...player.headers, 'idempotency-key': key },
    body: JSON.stringify({ item_id: itemId }),
  });

/** A launched player (real identity user) holding `amount` coins in the production wallet. */
const funded = async (amount = 1000): Promise<PlayerSession> => {
  const player = await tenantA.player();
  await seedCoins(tenantA.tenantId, player.userId, amount, { operatorToken: operatorPaymentsA });
  return player;
};

describe('bonus store (engagement) against real Postgres', () => {
  // Mutation: replace the conditional stock UPDATE with read-then-write -> more than 7 wins.
  it('I-ORDER-2/AC-065 stock never goes below zero under 50 parallel reservations', async () => {
    const item = await createItem({ stock: 7 });
    const players = await Promise.all(Array.from({ length: 50 }, () => tenantA.player()));
    // I-ORDER-2: publish 50 events, then wait once for all 50 balances
    await seedCoinsMany(
      tenantA.tenantId,
      players.map((p) => ({ playerId: p.userId, coins: 1000 })),
      { operatorToken: operatorPaymentsA },
    );
    const res = await Promise.all(players.map((p) => redeem(p, item.id, `key-${uuidv7()}`)));
    const bodies = await Promise.all(
      res.map(async (r) => ({ s: r.status, b: (await r.json()) as { code?: string } })),
    );
    expect(bodies.filter((x) => x.s === 202)).toHaveLength(7);
    for (const x of bodies.filter((y) => y.s !== 202)) {
      expect(x.s).toBe(409);
      expect(x.b.code).toBe('out_of_stock');
    }
  });

  // Mutation: drop the unique (tenant, player, operation key) constraint / dedupe lookup.
  it('I-ORDER-1/MIO-142 the same key sent 10 times in parallel -> one redemption', async () => {
    const item = await createItem({ stock: 5 });
    const key = `key-${uuidv7()}`;
    const p1 = await funded();
    const res = await Promise.all(Array.from({ length: 10 }, () => redeem(p1, item.id, key)));
    const ok = res.filter((r) => r.status === 202);
    expect(ok.length).toBeGreaterThan(0);
    // D-3: an in-flight duplicate is a retryable 409 with a stable code
    for (const r of res.filter((x) => x.status !== 202)) {
      expect(r.status).toBe(409);
      expect(((await r.json()) as { code: string }).code).toBe('idempotency_in_progress');
    }
    // every completed response is the same stored body, and a later replay returns it again
    const bodies = await Promise.all(ok.map(async (r) => JSON.stringify(await r.json())));
    expect(new Set(bodies).size).toBe(1);
    const replay = await redeem(p1, item.id, key);
    expect(replay.status).toBe(202);
    expect(replay.headers.get('idempotent-replayed')).toBe('true');
    expect(JSON.stringify(await replay.json())).toBe(bodies[0]);
  });

  it('I-ORDER-1b the same key with a different item is 422 idempotency_key_reused', async () => {
    const i1 = await createItem({ stock: 5 });
    const i2 = await createItem({ stock: 5 });
    const key = `key-${uuidv7()}`;
    const p1 = await funded();
    expect((await redeem(p1, i1.id, key)).status).toBe(202);
    const res = await redeem(p1, i2.id, key);
    expect(res.status).toBe(422);
    expect(((await res.json()) as { code?: string }).code).toBe('idempotency_key_reused');
  });

  // Mutation: look up by id alone, or drop the RLS policy on redemptions.
  it("I-OWN-1 player B cannot read A's redemption; another tenant cannot either; a sandbox player cannot", async () => {
    const item = await createItem({ stock: 5 });
    const alice = await funded();
    const bob = await tenantA.player();
    const outsider = await tenantB.player(alice.externalPlayerId); // same casino id, other tenant
    const sandboxAlice = await tenantA.sandboxPlayer(alice.externalPlayerId);
    const created = await redeem(alice, item.id, `key-${uuidv7()}`);
    const { id } = (await created.json()) as { id: string };
    const get = (p: PlayerSession) =>
      fetch(`${urls.engagement}/v1/redemptions/${id}`, { headers: p.headers });
    expect((await get(alice)).status).toBe(200);
    expect((await get(bob)).status).toBe(404);
    expect((await get(outsider)).status).toBe(404);
    // the same user through a sandbox credential has a sandbox scope (`sbx`): it cannot see a production order
    expect((await get(sandboxAlice)).status).toBe(404);
  });

  // W-5. The widget lists its own orders. Mutation: list the tenant's orders, or ignore the scope.
  it('W-5 GET /v1/me/redemptions lists only the caller own redemptions', async () => {
    const item = await createItem({ stock: 5 });
    const alice = await funded();
    const bob = await funded();
    await redeem(alice, item.id, `key-${uuidv7()}`);
    await redeem(bob, item.id, `key-${uuidv7()}`);
    const list = (await (
      await fetch(`${urls.engagement}/v1/me/redemptions`, { headers: alice.headers })
    ).json()) as Array<{ status: string }>;
    expect(list).toHaveLength(1);
    expect(['pending', 'issuing', 'issued', 'failed_refunded']).toContain(list[0]?.status);
  });

  // D-8 / F9: the coin reserve is synchronous, so a player without coins hears it on the POST.
  // Mutation: answer 202 and park the failure on GET.
  it('I-OUTCOME-2 a player without coins gets 409 insufficient_funds on the POST, and the stock is back', async () => {
    const item = await createItem({ stock: 1 });
    const poor = await tenantA.player(); // a real player, no coins
    const res = await redeem(poor, item.id, `key-${uuidv7()}`);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe('insufficient_funds');
    const rich = await funded();
    expect((await redeem(rich, item.id, `key-${uuidv7()}`)).status).toBe(202); // the one item is free again
  });

  // X-2/X-4/D-13. A sandbox player's coins are sandbox coins: production coins cannot be spent in the
  // sandbox and the reverse. Mutation: the reserve ignores the environment flag.
  it('I-SANDBOX-3 a sandbox player spends only sandbox coins; production coins do not fund a sandbox order', async () => {
    const item = await createItem({ stock: 5 });
    const prodPlayer = await funded(); // production coins only
    const sbxSameUser = await tenantA.sandboxPlayer(prodPlayer.externalPlayerId);
    expect(sbxSameUser.userId).toBe(prodPlayer.userId);
    const refused = await redeem(sbxSameUser, item.id, `key-${uuidv7()}`);
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { code: string }).code).toBe('insufficient_funds');
    await seedCoins(tenantA.tenantId, sbxSameUser.userId, 100, {
      sandbox: true,
      operatorToken: operatorPaymentsA,
      sandboxPlayerHeaders: sbxSameUser.headers, // the operator route reads production only (X-2)
    });
    expect((await redeem(sbxSameUser, item.id, `key-${uuidv7()}`)).status).toBe(202);
  });

  it('I-ISO-1 a tenant sees only its own items', async () => {
    const mine = await createItem({ stock: 1 });
    const other = await tenantB.player();
    const res = await fetch(`${urls.engagement}/v1/store/items`, { headers: other.headers });
    expect(res.status).toBe(200);
    const list = (await res.json()) as { id: string }[];
    expect(list.map((i) => i.id)).not.toContain(mine.id);
  });

  // Mutation: grant BYPASSRLS to the service role, or create the tables without FORCE RLS.
  it('I-ISO-2 the service role itself reads no store rows without a tenant', async () => {
    const db = await pgAs('engagement_app');
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
    const item = await createItem({ stock: 5 });
    const created = await redeem(await funded(), item.id, `key-${uuidv7()}`);
    const { id } = (await created.json()) as { id: string };
    const db = await pgAs('engagement_app');
    try {
      await db.query('BEGIN');
      await db.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantB.tenantId]);
      expect((await db.query('SELECT 1 FROM redemptions WHERE id = $1', [id])).rowCount).toBe(0);
      await db.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantA.tenantId]);
      const row = await db.query('SELECT price, state, sandbox FROM redemptions WHERE id = $1', [
        id,
      ]);
      // the coin reserve is inline now, so the order has usually moved past REQUESTED already
      expect(row.rows[0]).toMatchObject({ price: 10, sandbox: false });
      expect(['REQUESTED', 'RESERVED', 'ISSUING', 'UNKNOWN', 'ISSUED', 'COMPLETED']).toContain(
        row.rows[0].state,
      );
      await db.query('ROLLBACK');
    } finally {
      await db.end();
    }
  });
});
