import { Credit, uuidv7 } from '@ex-mio/contracts';
import { pgAs, urls } from './env';

const post = (tenant: string, key: string, body: unknown) =>
  fetch(`${urls.payments}/v1/credits`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-tenant-id': tenant,
      'x-principal-id': 'op-1',
      'idempotency-key': key,
    },
    body: JSON.stringify(body),
  });

const list = async (tenant: string): Promise<Credit[]> => {
  const res = await fetch(`${urls.payments}/v1/credits`, { headers: { 'x-tenant-id': tenant } });
  expect(res.status).toBe(200);
  return Credit.array().parse(await res.json());
};

describe('tenant isolation and idempotency (payments)', () => {
  const tenantA = uuidv7();
  const tenantB = uuidv7();
  const player = uuidv7();

  it('refuses a request without a tenant', async () => {
    expect((await fetch(`${urls.payments}/v1/credits`)).status).toBe(401);
  });

  it('a retry with the same key and body replays the first answer and credits once', async () => {
    const key = `key-${uuidv7()}`;
    const first = await post(tenantA, key, { player_id: player, amount: 10 });
    const second = await post(tenantA, key, { amount: 10, player_id: player }); // key order differs
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.headers.get('idempotent-replayed')).toBe('true');
    expect(((await first.json()) as Credit).id).toBe(((await second.json()) as Credit).id);
    expect((await list(tenantA)).filter((c) => c.player_id === player)).toHaveLength(1);
  });

  it('the same key with a different body is 422 and credits nothing', async () => {
    const key = `key-${uuidv7()}`;
    expect((await post(tenantA, key, { player_id: player, amount: 1 })).status).toBe(201);
    const before = (await list(tenantA)).length;
    expect((await post(tenantA, key, { player_id: player, amount: 2 })).status).toBe(422);
    expect((await list(tenantA)).length).toBe(before);
  });

  it('a tenant sees only its own rows', async () => {
    expect(
      (await post(tenantB, `key-${uuidv7()}`, { player_id: uuidv7(), amount: 7 })).status,
    ).toBe(201);
    const a = await list(tenantA);
    const b = await list(tenantB);
    expect(b).toHaveLength(1);
    expect(a.some((c) => b.some((x) => x.id === c.id))).toBe(false);
  });

  it('row-level security binds the runtime role: without a tenant set it reads nothing and writes nothing', async () => {
    const admin = await pgAs('postgres');
    const total = await (async () => {
      const c = await pgAs('payments_app');
      try {
        // The runtime role connects; no `SET LOCAL app.tenant_id` has been issued.
        const rows = await c.query(`SELECT count(*)::int AS n FROM coin_credits`);
        await expect(
          c.query(
            `INSERT INTO coin_credits (id, tenant_id, player_id, amount) VALUES ($1, $2, $3, 1)`,
            [uuidv7(), tenantA, player],
          ),
        ).rejects.toThrow(/row-level security/);
        return rows.rows[0].n as number;
      } finally {
        await c.end();
      }
    })();
    expect(total).toBe(0);
    await admin.end();
  });
});
