import { CoinOperationResult, uuidv7, WalletBalance } from '@ex-mio/contracts';
import { pgAs, serviceSecrets, urls } from './env';
import { newTenant, type PlayerSession, type TestTenant } from './player-session';
import { seedCoins } from './seed-coins';

/*
 * Tenant isolation and idempotency of a payments money route, against the live stack.
 *
 * D-24 (int/all review): the old version called the removed `POST/GET /v1/credits` with
 * `x-tenant-id` / `x-principal-id` headers. Today's real money route is the internal coin reserve
 * (`POST /internal/v1/tenants/:tenantId/reserves`), called with an engagement service token, as the
 * redemption saga does; balances are read by the tenant's operator. The properties are the same:
 *  - no credentials, no tenant: 401;
 *  - a retry with the same key and body replays the stored answer and holds the coins once;
 *  - the same key with another body is 422 and holds nothing more;
 *  - a tenant cannot see or move another tenant's wallet;
 *  - RLS binds the runtime role when no tenant is set: it reads nothing and writes nothing.
 *
 * Mutations: drop runIdempotent around the reserve (second hold) / the body hash check (no 422);
 * look the wallet up by player id alone, without tenant (B reads A); drop FORCE RLS on wallets.
 */

const json = { 'content-type': 'application/json' };

const engagementToPayments = async (): Promise<string> => {
  const res = await fetch(`${urls.identity}/v1/auth/service-token`, {
    method: 'POST',
    headers: json,
    body: JSON.stringify({
      client_id: 'engagement',
      client_secret: serviceSecrets.engagement,
      audience: 'payments',
    }),
  });
  expect(res.status).toBe(200);
  return ((await res.json()) as { access_token: string }).access_token;
};

const reserve = (svc: string, tenantId: string, key: string, body: Record<string, unknown>) =>
  fetch(`${urls.payments}/internal/v1/tenants/${tenantId}/reserves`, {
    method: 'POST',
    headers: { ...json, authorization: `Bearer ${svc}`, 'idempotency-key': key },
    body: JSON.stringify(body),
  });

const balanceAs = (operatorToken: string, playerId: string) =>
  fetch(`${urls.payments}/v1/players/${playerId}/balance`, {
    headers: { authorization: `Bearer ${operatorToken}` },
  });

describe('tenant isolation and idempotency (payments)', () => {
  let a: TestTenant;
  let b: TestTenant;
  let opA: string;
  let opB: string;
  let svc: string;
  let player: PlayerSession;
  const heldOf = async (playerId = player.userId) =>
    WalletBalance.parse(await (await balanceAs(opA, playerId)).json()).held;

  beforeAll(async () => {
    [a, b] = await Promise.all([newTenant(), newTenant()]);
    [opA, opB, svc] = await Promise.all([
      a.operatorToken('payments'),
      b.operatorToken('payments'),
      engagementToPayments(),
    ]);
    player = await a.player();
    await seedCoins(a.tenantId, player.userId, 100, { operatorToken: opA });
  });

  it('refuses a request without a tenant', async () => {
    expect((await fetch(`${urls.payments}/v1/me/balance`)).status).toBe(401);
    const anonymous = await fetch(`${urls.payments}/internal/v1/tenants/${a.tenantId}/reserves`, {
      method: 'POST',
      headers: { ...json, 'idempotency-key': `key-${uuidv7()}` },
      body: JSON.stringify({
        player_id: player.userId,
        reserve_id: uuidv7(),
        amount: 1,
        sandbox: false,
      }),
    });
    expect(anonymous.status).toBe(401);
  });

  it('a retry with the same key and body replays the first answer and holds once', async () => {
    const key = `key-${uuidv7()}`;
    const reserveId = uuidv7();
    const before = await heldOf();
    const first = await reserve(svc, a.tenantId, key, {
      player_id: player.userId,
      reserve_id: reserveId,
      amount: 10,
      sandbox: false,
    });
    const second = await reserve(svc, a.tenantId, key, {
      sandbox: false,
      amount: 10,
      reserve_id: reserveId,
      player_id: player.userId,
    }); // key order differs
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.headers.get('idempotent-replayed')).toBe('true');
    const [r1, r2] = [
      CoinOperationResult.parse(await first.json()),
      CoinOperationResult.parse(await second.json()),
    ];
    expect(r2.transaction_id).toBe(r1.transaction_id);
    expect(await heldOf()).toBe(before + 10);
  });

  it('the same key with a different body is 422 and holds nothing', async () => {
    const key = `key-${uuidv7()}`;
    const body = { player_id: player.userId, reserve_id: uuidv7(), amount: 1, sandbox: false };
    expect((await reserve(svc, a.tenantId, key, body)).status).toBe(201);
    const before = await heldOf();
    expect((await reserve(svc, a.tenantId, key, { ...body, amount: 2 })).status).toBe(422);
    expect(await heldOf()).toBe(before);
  });

  it("a tenant sees only its own rows: B's operator cannot read A's wallet, and B's path cannot hold A's coins", async () => {
    expect((await balanceAs(opA, player.userId)).status).toBe(200);
    expect((await balanceAs(opB, player.userId)).status).toBe(404);
    const before = await heldOf();
    const crossed = await reserve(svc, b.tenantId, `key-${uuidv7()}`, {
      player_id: player.userId,
      reserve_id: uuidv7(),
      amount: 1,
      sandbox: false,
    });
    expect(crossed.status).toBeGreaterThanOrEqual(400);
    expect(await heldOf()).toBe(before);
  });

  it('row-level security binds the runtime role: without a tenant set it reads nothing and writes nothing', async () => {
    const c = await pgAs('payments_app');
    try {
      // The runtime role connects; no `SET LOCAL app.tenant_id` has been issued.
      const rows = await c.query(`SELECT count(*)::int AS n FROM wallets`);
      expect(rows.rows[0].n).toBe(0);
      await expect(
        c.query(`INSERT INTO wallets (tenant_id, id, sandbox) VALUES ($1, $2, false)`, [
          a.tenantId,
          uuidv7(),
        ]),
      ).rejects.toThrow(/row-level security/);
    } finally {
      await c.end();
    }
    // and the tenant's wallets do exist: the zero above is RLS, not an empty table
    const admin = await pgAs('postgres', 'payments');
    try {
      const all = await admin.query(`SELECT count(*)::int AS n FROM wallets WHERE tenant_id = $1`, [
        a.tenantId,
      ]);
      expect(all.rows[0].n).toBeGreaterThan(0);
    } finally {
      await admin.end();
    }
  });
});
