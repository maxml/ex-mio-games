import { IdempotencyMismatchError } from '@ex-mio/idempotency';
import { uuidv7, parseEvent, type EventEnvelope } from '@ex-mio/contracts';
import { key, newPlayer, newTenant, openHarness, type Harness } from '../testing/harness';
import { LedgerError } from './ledger.errors';

// Choke point: `LedgerService` (one database transaction per command) over the real database.
// Each test names the mutation that must turn it red. Spec: docs/specs/payments.md, section 5.

let h: Harness;
beforeAll(async () => {
  h = await openHarness();
});
afterAll(async () => h.close());

const credit = (t: string, player: string, amount: number, spin = uuidv7(), k = key('credit')) =>
  h.as(t, () => h.ledger.credit({ player_id: player, spin_id: spin, amount, currency: 'COIN' }, k));
const reserve = (t: string, player: string, amount: number, id = uuidv7(), k = key('reserve')) =>
  h.as(t, () =>
    h.ledger.reserve({ player_id: player, reserve_id: id, amount, currency: 'COIN' }, k),
  );
const capture = (t: string, id: string, k = key('capture')) =>
  h.as(t, () => h.ledger.capture({ reserve_id: id }, k));
const release = (t: string, id: string, k = key('release')) =>
  h.as(t, () => h.ledger.release({ reserve_id: id }, k));
const refund = (t: string, id: string, k = key('refund')) =>
  h.as(t, () => h.ledger.refund({ reserve_id: id }, k));

const wallet = async (t: string, player: string) => h.as(t, () => h.balances.readByPlayer(player));

async function count(table: string, tenant: string): Promise<number> {
  const { rows } = await h.admin.query(
    `SELECT count(*)::int AS n FROM ${table} WHERE tenant_id = $1`,
    [tenant],
  );
  return rows[0].n;
}

async function outbox(tenant: string): Promise<EventEnvelope[]> {
  const { rows } = await h.admin.query(
    `SELECT envelope FROM outbox WHERE tenant_id = $1 ORDER BY created_at, event_id`,
    [tenant],
  );
  return rows.map((r) => parseEvent(r.envelope));
}

describe('INV-C1 concurrent reserves never overspend', () => {
  // Mutation: read the balance first and write `available = <value read>` (read-then-write),
  // or drop the `AND amount >= $n` guard from the conditional update.
  it('50 parallel reserves against a balance that covers 7: exactly 7 succeed, 43 are insufficient_funds', async () => {
    const t = newTenant();
    const p = newPlayer();
    await credit(t, p, 7);
    const results = await Promise.allSettled(Array.from({ length: 50 }, () => reserve(t, p, 1)));
    const ok = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
    expect(ok).toHaveLength(7);
    expect(rejected).toHaveLength(43);
    for (const r of rejected) expect(r.reason).toMatchObject({ code: 'insufficient_funds' });
    expect(await wallet(t, p)).toMatchObject({ available: 0, held: 7 });
  });
});

describe('INV-C2 mixed concurrent credits and reserves conserve the total', () => {
  // Mutation: compute the new balance from a value read before the transaction (lost update).
  it('100 parallel credits and reserves: available + held == start + credited, held == successful reserves', async () => {
    const t = newTenant();
    const p = newPlayer();
    await credit(t, p, 20);
    const ops = Array.from({ length: 100 }, (_, i) =>
      i % 2 === 0
        ? credit(t, p, 3).then(() => 'credit' as const)
        : reserve(t, p, 1).then(() => 'reserve' as const),
    );
    const settled = await Promise.allSettled(ops);
    const credits = settled.filter((r) => r.status === 'fulfilled' && r.value === 'credit').length;
    const reserves = settled.filter(
      (r) => r.status === 'fulfilled' && r.value === 'reserve',
    ).length;
    expect(credits).toBe(50); // credits cannot fail
    const w = await wallet(t, p);
    expect(w.available + w.held).toBe(20 + 3 * credits);
    expect(w.held).toBe(reserves);
    expect(w.available).toBeGreaterThanOrEqual(0);
  });
});

describe('INV-I1 the same key and body replays one effect', () => {
  // Mutation: skip runIdempotent (or write the idempotency row in a second transaction).
  it('credit twice with one key credits once and returns the same response', async () => {
    const t = newTenant();
    const p = newPlayer();
    const spin = uuidv7();
    const k = key('credit');
    const first = await credit(t, p, 10, spin, k);
    const second = await credit(t, p, 10, spin, k);
    expect(second.replayed).toBe(true);
    expect(second.body).toEqual(first.body);
    expect(await count('journal_transactions', t)).toBe(1);
    expect((await wallet(t, p)).available).toBe(10);
  });
});

describe('INV-I2 the same key with a changed body is refused and executes nothing', () => {
  // Mutation: drop the request-hash comparison in the idempotency check.
  it('422 idempotency_key_reused, journal unchanged', async () => {
    const t = newTenant();
    const p = newPlayer();
    const spin = uuidv7();
    const k = key('credit');
    await credit(t, p, 10, spin, k);
    await expect(credit(t, p, 11, spin, k)).rejects.toBeInstanceOf(IdempotencyMismatchError);
    expect(await count('journal_transactions', t)).toBe(1);
    expect((await wallet(t, p)).available).toBe(10);
  });
});

describe('INV-I3 replay after the HTTP idempotency record expired still has no second effect', () => {
  // Mutation: drop UNIQUE (tenant_id, operation_type, operation_id), or derive operation_id from the key.
  it('credit: same spin, new key, record purged: the first transaction is returned', async () => {
    const t = newTenant();
    const p = newPlayer();
    const spin = uuidv7();
    const first = await credit(t, p, 10, spin);
    await h.admin.query(`DELETE FROM idempotency_keys WHERE tenant_id = $1`, [t]);
    const again = await credit(t, p, 10, spin, key('late-retry'));
    expect(again.body.transaction_id).toBe(first.body.transaction_id);
    expect(await count('journal_transactions', t)).toBe(1);
    expect((await wallet(t, p)).available).toBe(10);
  });

  // Mutation: return the first result without comparing the parameters.
  it('the same spin with another amount is operation_conflict, not a second award', async () => {
    const t = newTenant();
    const p = newPlayer();
    const spin = uuidv7();
    await credit(t, p, 10, spin);
    await expect(credit(t, p, 99, spin, key('other'))).rejects.toMatchObject({
      code: 'operation_conflict',
    });
    expect(await count('journal_transactions', t)).toBe(1);
  });
});

describe('INV-T1 reserve transitions: reserved -> captured | released; captured -> refunded', () => {
  // Mutation: remove the `WHERE state = 'reserved'` guard from the conditional state update.
  it('capture after release is rejected and changes nothing', async () => {
    const t = newTenant();
    const p = newPlayer();
    await credit(t, p, 10);
    const id = uuidv7();
    await reserve(t, p, 4, id);
    await release(t, id);
    const before = await count('journal_transactions', t);
    await expect(capture(t, id)).rejects.toMatchObject({ code: 'invalid_reserve_transition' });
    expect(await count('journal_transactions', t)).toBe(before);
    expect(await wallet(t, p)).toMatchObject({ available: 10, held: 0 });
  });

  it('release after capture is rejected', async () => {
    const t = newTenant();
    const p = newPlayer();
    await credit(t, p, 10);
    const id = uuidv7();
    await reserve(t, p, 4, id);
    await capture(t, id);
    await expect(release(t, id)).rejects.toMatchObject({ code: 'invalid_reserve_transition' });
    expect(await wallet(t, p)).toMatchObject({ available: 6, held: 0 });
  });

  it('release returns the available balance to its starting value', async () => {
    const t = newTenant();
    const p = newPlayer();
    await credit(t, p, 10);
    const id = uuidv7();
    await reserve(t, p, 10, id);
    expect(await wallet(t, p)).toMatchObject({ available: 0, held: 10 });
    await release(t, id);
    expect(await wallet(t, p)).toMatchObject({ available: 10, held: 0 });
  });

  it('refund needs a captured reserve, returns the coins once, and is not repeatable', async () => {
    const t = newTenant();
    const p = newPlayer();
    await credit(t, p, 10);
    const id = uuidv7();
    await reserve(t, p, 4, id);
    await expect(refund(t, id)).rejects.toMatchObject({ code: 'invalid_reserve_transition' });
    await capture(t, id);
    await refund(t, id);
    expect(await wallet(t, p)).toMatchObject({ available: 10, held: 0 });
    await expect(refund(t, id, key('second-refund'))).rejects.toMatchObject({
      code: 'invalid_reserve_transition',
    });
    expect(await wallet(t, p)).toMatchObject({ available: 10, held: 0 });
  });

  // Mutation: look the reserve up without the tenant filter / outside RLS.
  it("an unknown reserve id, and another tenant's reserve id, are reserve_not_found", async () => {
    const t = newTenant();
    const other = newTenant();
    const p = newPlayer();
    await credit(other, p, 10);
    const id = uuidv7();
    await reserve(other, p, 4, id);
    await expect(capture(t, uuidv7())).rejects.toMatchObject({ code: 'reserve_not_found' });
    await expect(capture(t, id)).rejects.toMatchObject({ code: 'reserve_not_found' });
    expect(await wallet(other, p)).toMatchObject({ available: 6, held: 4 });
  });
});

describe('INV-T2 each phase is idempotent on its own key; a double capture is one capture', () => {
  // Mutation: let capture insert a second journal transaction (drop the per-phase operation key).
  it('capture twice with one key: one capture, same response', async () => {
    const t = newTenant();
    const p = newPlayer();
    await credit(t, p, 10);
    const id = uuidv7();
    await reserve(t, p, 4, id);
    const k = key('capture');
    const first = await capture(t, id, k);
    const second = await capture(t, id, k);
    expect(second.replayed).toBe(true);
    expect(second.body).toEqual(first.body);
    const { rows } = await h.admin.query(
      `SELECT count(*)::int AS n FROM journal_transactions WHERE tenant_id = $1 AND operation_type = 'capture'`,
      [t],
    );
    expect(rows[0].n).toBe(1);
  });

  it('capture twice with different keys: the second is refused, the balance moves once', async () => {
    const t = newTenant();
    const p = newPlayer();
    await credit(t, p, 10);
    const id = uuidv7();
    await reserve(t, p, 4, id);
    await capture(t, id);
    await expect(capture(t, id, key('capture-again'))).rejects.toMatchObject({
      code: 'invalid_reserve_transition',
    });
    expect(await wallet(t, p)).toMatchObject({ available: 6, held: 0 });
  });
});

describe('INV-T3 a reserve id is explicit and reserves once', () => {
  // Mutation: generate the reserve id inside payments instead of taking it from the command.
  it('the same reserve id with another key and the same body returns the first reserve', async () => {
    const t = newTenant();
    const p = newPlayer();
    await credit(t, p, 10);
    const id = uuidv7();
    const first = await reserve(t, p, 4, id);
    const again = await reserve(t, p, 4, id, key('retry'));
    expect(first.body.reserve_id).toBe(id);
    expect(again.body.transaction_id).toBe(first.body.transaction_id);
    expect(await wallet(t, p)).toMatchObject({ available: 6, held: 4 });
  });

  it('the same reserve id with another amount is operation_conflict', async () => {
    const t = newTenant();
    const p = newPlayer();
    await credit(t, p, 10);
    const id = uuidv7();
    await reserve(t, p, 4, id);
    await expect(reserve(t, p, 5, id, key('retry'))).rejects.toMatchObject({
      code: 'operation_conflict',
    });
  });

  it('a reserve above the balance is insufficient_funds and leaves no reserve row', async () => {
    const t = newTenant();
    const p = newPlayer();
    await credit(t, p, 3);
    const id = uuidv7();
    await expect(reserve(t, p, 4, id)).rejects.toMatchObject({ code: 'insufficient_funds' });
    expect(await count('reserves', t)).toBe(0);
    await expect(capture(t, id)).rejects.toMatchObject({ code: 'reserve_not_found' });
  });
});

describe('INV-A1 effect, ledger and outbox commit or roll back together', () => {
  // Mutation: commit the journal before the balance update / outbox insert (second transaction),
  // or catch the error and carry on.
  it.each(['after_journal', 'after_balance', 'after_outbox'] as const)(
    'credit failing %s leaves nothing: no transaction, entries, balance change, idempotency row, outbox row',
    async (point) => {
      const t = newTenant();
      const p = newPlayer();
      await credit(t, p, 5); // establish the wallet
      const snap = async () => ({
        journal: await count('journal_transactions', t),
        entries: await count('ledger_entries', t),
        idem: await count('idempotency_keys', t),
        out: await count('outbox', t),
        wallet: await wallet(t, p),
      });
      const before = await snap();
      const spin = uuidv7();
      const k = key('credit');
      h.failAt(point);
      await expect(credit(t, p, 7, spin, k)).rejects.toThrow(/injected fault/);
      expect(await snap()).toEqual(before);
      // The failed attempt did not poison the key: a retry applies exactly once.
      const retry = await credit(t, p, 7, spin, k);
      expect(retry.replayed).toBe(false);
      expect((await wallet(t, p)).available).toBe(12);
    },
  );

  it.each(['after_journal', 'after_balance', 'after_outbox'] as const)(
    'reserve failing %s leaves no reserve row and no held coins',
    async (point) => {
      const t = newTenant();
      const p = newPlayer();
      await credit(t, p, 5);
      const before = { r: await count('reserves', t), j: await count('journal_transactions', t) };
      h.failAt(point);
      await expect(reserve(t, p, 2)).rejects.toThrow(/injected fault/);
      expect({ r: await count('reserves', t), j: await count('journal_transactions', t) }).toEqual(
        before,
      );
      expect(await wallet(t, p)).toMatchObject({ available: 5, held: 0 });
    },
  );

  // Mutation: let LedgerError swallowing turn a failure into a defined-but-wrong success.
  it('a failure is never answered as success', async () => {
    const t = newTenant();
    const p = newPlayer();
    h.failAt('after_balance');
    const err = await credit(t, p, 5).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(LedgerError); // an infrastructure failure is not a domain answer
  });
});

describe('INV-E1 every phase writes its event in the same transaction', () => {
  // Mutation: do not enqueue the event for one phase, or enqueue it outside the effect transaction.
  it('credit, reserve, capture, release and refund each enqueue exactly one event with the balances after', async () => {
    const t = newTenant();
    const p = newPlayer();
    await credit(t, p, 10);
    const a = uuidv7();
    const b = uuidv7();
    await reserve(t, p, 4, a);
    await capture(t, a);
    await refund(t, a);
    await reserve(t, p, 3, b);
    await release(t, b);
    const events = await outbox(t);
    expect(events.map((e) => e.type)).toEqual([
      'payments.coins.credited',
      'payments.coins.reserved',
      'payments.coins.captured',
      'payments.coins.refunded',
      'payments.coins.reserved',
      'payments.coins.released',
    ]);
    const reserved = events[1]!.payload as {
      reserve_id: string;
      available_after: number;
      held_after: number;
    };
    expect(reserved).toMatchObject({ reserve_id: a, available_after: 6, held_after: 4 });
    const released = events[5]!.payload as { available_after: number; held_after: number };
    expect(released).toMatchObject({ available_after: 10, held_after: 0 });
  });

  it('a replay does not enqueue a second event', async () => {
    const t = newTenant();
    const p = newPlayer();
    const spin = uuidv7();
    const k = key('credit');
    await credit(t, p, 10, spin, k);
    await credit(t, p, 10, spin, k);
    expect(await outbox(t)).toHaveLength(1);
  });
});

describe('INV-O2 erasing the identity link keeps the stable account', () => {
  // Mutation: make eraseIdentityLink delete the wallet or its entries, or leave the link in place.
  it('the link is gone, the wallet id still reads its balance, the player id no longer resolves', async () => {
    const t = newTenant();
    const p = newPlayer();
    const first = await credit(t, p, 10);
    const walletId = first.body.balance.wallet_id;
    await h.as(t, () => h.ledger.eraseIdentityLink(p));
    expect(await count('wallet_owner_links', t)).toBe(0);
    expect(await h.as(t, () => h.balances.readByWallet(walletId))).toMatchObject({ available: 10 });
    await expect(h.as(t, () => h.balances.readByPlayer(p))).rejects.toMatchObject({
      code: 'wallet_not_found',
    });
    expect(await count('ledger_entries', t)).toBe(2);
  });
});
