import { createEvent, uuidv7 } from '@ex-mio/contracts';
import { tenantCacheKey } from '@ex-mio/tenancy';
import { key, newPlayer, newTenant, openHarness, type Harness } from '../testing/harness';

// Choke point: `BalanceService` (read path and Redis projection). Spec: docs/specs/payments.md, section 6.
// Funding goes through the inbox (`h.fund`); only this file reads balances through BalanceService.

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

describe('INV-B1 a balance read is fresh after a change, and survives Redis being down', () => {
  // Mutation: never invalidate the projection on a coin event.
  it('after a credit and its event, the read returns the new balance', async () => {
    const t = newTenant();
    const p = newPlayer();
    await h.fund(t, p, 5);
    const wallet = await h.dbWallet(t, p);
    expect(await h.as(t, () => h.balances.readByPlayer(p))).toMatchObject({ available: 5 });
    const { spinId } = await h.fund(t, p, 7);
    const { rows } = await h.admin.query(
      `SELECT id FROM journal_transactions WHERE tenant_id = $1 AND operation_id = $2`,
      [t, spinId],
    );
    await h.as(t, () =>
      h.balances.onCoinEvent(
        createEvent({
          type: 'payments.coins.credited',
          tenantId: t,
          payload: { credit_id: rows[0].id, player_id: p, amount: 7 },
        }),
      ),
    );
    expect(await h.as(t, () => h.balances.readByPlayer(p))).toMatchObject({
      available: 12,
      wallet_id: wallet.wallet_id,
    });
  });

  // Mutation: let a cache error propagate from the read path.
  it('with Redis down the read falls back to the database', async () => {
    const t = newTenant();
    const p = newPlayer();
    await h.fund(t, p, 5);
    h.cache.down = true;
    expect(await h.as(t, () => h.balances.readByPlayer(p))).toMatchObject({ available: 5 });
  });
});

describe('INV-B2 the cache is tenant-scoped and never used by a command (decision D-9)', () => {
  // Mutation: build the key without tenantCacheKey (a bare `balance:<wallet>`).
  it('a warm entry of one player is never served to another, in the same or another tenant', async () => {
    const tA = newTenant();
    const tB = newTenant();
    const a = newPlayer();
    const b = newPlayer();
    const c = newPlayer();
    await h.fund(tA, a, 5);
    await h.fund(tA, b, 9);
    await h.fund(tB, c, 100);
    const wa = (await h.as(tA, () => h.balances.readByPlayer(a))).wallet_id; // warms A
    expect(await h.as(tA, () => h.balances.readByPlayer(b))).toMatchObject({ available: 9 });
    expect(await h.as(tB, () => h.balances.readByPlayer(c))).toMatchObject({ available: 100 });
    expect(h.cache.store.has(tenantCacheKey(tA, 'balance', wa))).toBe(true);
    for (const k of h.cache.store.keys()) expect(k).toMatch(/^t:[0-9a-f-]{36}:balance:/);
  });

  // Mutation: let reserve read the balance from the cache (BALANCE_CACHE) to decide.
  it('a poisoned cache entry does not let a reserve overspend', async () => {
    const t = newTenant();
    const p = newPlayer();
    await h.fund(t, p, 3);
    const wallet = await h.dbWallet(t, p);
    h.cache.store.set(
      tenantCacheKey(t, 'balance', wallet.wallet_id),
      JSON.stringify({ available: 1_000_000, held: 0 }),
    );
    h.cache.calls.length = 0;
    await expect(
      h.as(t, () =>
        h.ledger.reserve(
          { player_id: p, reserve_id: uuidv7(), amount: 50, currency: 'COIN' },
          key('reserve'),
        ),
      ),
    ).rejects.toMatchObject({ code: 'insufficient_funds' });
    expect(h.cache.calls).toEqual([]);
  });

  // Mutation: invalidate or fill the cache from a command or from the spin path, or read it there.
  it('no command and no spin credit makes ANY cache call, and they work with Redis down', async () => {
    const t = newTenant();
    const p = newPlayer();
    h.cache.down = true; // any touch would throw, and would be recorded in `calls`
    await h.fund(t, p, 10);
    const id = uuidv7();
    const run = (fn: () => Promise<unknown>) => h.as(t, fn);
    await run(() =>
      h.ledger.reserve({ player_id: p, reserve_id: id, amount: 4, currency: 'COIN' }, key('r')),
    );
    await run(() => h.ledger.capture({ reserve_id: id }, key('c')));
    await run(() => h.ledger.refund({ reserve_id: id }, key('f')));
    expect(h.cache.calls).toEqual([]);
    expect(await h.dbWallet(t, p)).toMatchObject({ available: 10, held: 0 });
  });
});

describe('INV-B3 a balance is readable only inside its own tenant', () => {
  // Mutation: look the wallet up by player id without the tenant (RLS) filter.
  it('a player of tenant B has no wallet in tenant A: wallet_not_found', async () => {
    const tA = newTenant();
    const tB = newTenant();
    const p = newPlayer();
    await h.fund(tA, p, 5);
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
