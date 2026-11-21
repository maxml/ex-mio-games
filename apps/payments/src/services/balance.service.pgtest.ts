import { createEvent, uuidv7 } from '@ex-mio/contracts';
import { tenantCacheKey } from '@ex-mio/tenancy';
import { key, newPlayer, newTenant, openHarness, type Harness } from '../testing/harness';

// Choke point: `BalanceService` (read path and Redis projection). Spec: docs/specs/payments.md, section 6.

let h: Harness;
beforeAll(async () => {
  h = await openHarness();
});
afterAll(async () => h.close());
beforeEach(() => {
  h.cache.store.clear();
  h.cache.calls.length = 0;
  h.cache.down = false;
});

const credit = (t: string, player: string, amount: number) =>
  h.as(t, () =>
    h.ledger.credit(
      { player_id: player, spin_id: uuidv7(), amount, currency: 'COIN' },
      key('credit'),
    ),
  );

describe('INV-B1 a balance read is fresh after a change, and survives Redis being down', () => {
  // Mutation: never invalidate the projection on a coin event.
  it('after a credit and its event, the read returns the new balance', async () => {
    const t = newTenant();
    const p = newPlayer();
    const first = await credit(t, p, 5);
    expect(await h.as(t, () => h.balances.readByPlayer(p))).toMatchObject({ available: 5 });
    const second = await credit(t, p, 7);
    await h.as(t, () =>
      h.balances.onCoinEvent(
        createEvent({
          type: 'payments.coins.credited',
          tenantId: t,
          payload: { credit_id: second.body.transaction_id, player_id: p, amount: 7 },
        }),
      ),
    );
    expect(await h.as(t, () => h.balances.readByPlayer(p))).toMatchObject({ available: 12 });
    expect(first.body.balance.wallet_id).toBe(second.body.balance.wallet_id);
  });

  // Mutation: let a cache error propagate from the read path.
  it('with Redis down the read falls back to the database', async () => {
    const t = newTenant();
    const p = newPlayer();
    await credit(t, p, 5);
    h.cache.down = true;
    expect(await h.as(t, () => h.balances.readByPlayer(p))).toMatchObject({ available: 5 });
  });
});

describe('INV-B2 the cache is tenant-scoped and never used for a write decision', () => {
  // Mutation: build the key without tenantCacheKey (a bare `balance:<wallet>`).
  it('a warm entry of one player is never served to another, in the same or another tenant', async () => {
    const tA = newTenant();
    const tB = newTenant();
    const a = newPlayer();
    const b = newPlayer();
    const c = newPlayer();
    await credit(tA, a, 5);
    await credit(tA, b, 9);
    await credit(tB, c, 100);
    const wa = (await h.as(tA, () => h.balances.readByPlayer(a))).wallet_id; // warms A
    expect(await h.as(tA, () => h.balances.readByPlayer(b))).toMatchObject({ available: 9 });
    expect(await h.as(tB, () => h.balances.readByPlayer(c))).toMatchObject({ available: 100 });
    expect(h.cache.store.has(tenantCacheKey(tA, 'balance', wa))).toBe(true);
    for (const k of h.cache.store.keys()) expect(k).toMatch(/^t:[0-9a-f-]{36}:balance:/);
  });

  // Mutation: let reserve read the balance from the cache (BALANCE_CACHE) to decide.
  it('a poisoned cache entry does not let a reserve overspend, and the write path never touches the cache', async () => {
    const t = newTenant();
    const p = newPlayer();
    const first = await credit(t, p, 3);
    const poisoned = tenantCacheKey(t, 'balance', first.body.balance.wallet_id);
    h.cache.store.set(poisoned, JSON.stringify({ available: 1_000_000, held: 0 }));
    h.cache.calls.length = 0;
    await expect(
      h.as(t, () =>
        h.ledger.reserve(
          { player_id: p, reserve_id: uuidv7(), amount: 50, currency: 'COIN' },
          key('reserve'),
        ),
      ),
    ).rejects.toMatchObject({ code: 'insufficient_funds' });
    expect(h.cache.calls.filter((c) => c.startsWith('get'))).toEqual([]);
  });
});

describe('INV-B3 a balance is readable only inside its own tenant', () => {
  // Mutation: look the wallet up by player id without the tenant (RLS) filter.
  it('a player of tenant B has no wallet in tenant A: wallet_not_found', async () => {
    const tA = newTenant();
    const tB = newTenant();
    const p = newPlayer();
    await credit(tA, p, 5);
    await expect(h.as(tB, () => h.balances.readByPlayer(p))).rejects.toMatchObject({
      code: 'wallet_not_found',
    });
  });

  it('an unknown player is wallet_not_found, not an empty balance', async () => {
    await expect(
      h.as(newTenant(), () => h.balances.readByPlayer(newPlayer())),
    ).rejects.toMatchObject({
      code: 'wallet_not_found',
    });
  });
});
