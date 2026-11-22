import { createEvent, parseEvent, uuidv7 } from '@ex-mio/contracts';
import {
  newPlayer,
  newTenant,
  openHarness,
  spinCompleted,
  spinCompletedIn,
  type Harness,
} from '../testing/harness';

// Choke point: the payments inbox handler, reached through the REAL `InboxConsumer` (consumer name
// `payments`, foundation `packages/bus/src/inbox.ts`) as the runtime role. Decision D-1: engagement
// writes `spin.completed` to its outbox; payments credits the coins and meters the spin in ONE
// transaction with the inbox row. Delivery is at least once; the effect is exactly once.
// Spec: docs/specs/payments.md, sections 3 and 5. Test ids D1-1..D1-13 come from the stage A review.

let h: Harness;
beforeAll(async () => {
  h = await openHarness();
});
afterAll(async () => h.close());

const AT = '2026-11-05T10:00:00.000Z';

async function n(table: string, tenant: string, where = ''): Promise<number> {
  const { rows } = await h.admin.query(
    `SELECT count(*)::int AS n FROM ${table} WHERE tenant_id = $1 ${where}`,
    [tenant],
  );
  return rows[0].n;
}
const awards = (t: string, spin: string) =>
  n('journal_transactions', t, `AND operation_type = 'spin_award' AND operation_id = '${spin}'`);
const allJournal = (t: string) => n('journal_transactions', t);
const credited = (t: string) => n('outbox', t, `AND type = 'payments.coins.credited'`);
const inboxRows = (t: string) => n('inbox', t, `AND consumer = 'payments'`);
const spinsMetered = (t: string) => h.as(t, () => h.usage.report('2026-11')).then((r) => r.spins);

describe('D1-1 a spin delivered twice credits once', () => {
  // Mutation: credit before or outside the inbox insert (a handler that commits on its own).
  it('applied then duplicate: one inbox row, one spin_award, one credited event, coins once, both acked', async () => {
    const t = newTenant();
    const p = newPlayer();
    const spin = uuidv7();
    const e = spinCompleted(t, p, 7, { spinId: spin, at: AT });
    const first = await h.consume(e);
    const second = await h.consume(e);
    expect([first.outcome, second.outcome]).toEqual(['applied', 'duplicate']);
    expect(first.acked && second.acked).toBe(true);
    expect(await inboxRows(t)).toBe(1);
    expect(await awards(t, spin)).toBe(1);
    expect(await credited(t)).toBe(1);
    expect(await h.dbWallet(t, p)).toMatchObject({ available: 7, held: 0 });
  });

  // Mutation: key the credit by something other than the spin (overwrite instead of add).
  it('known-payment-defect-20: 5 coins then 7 coins is 12, not 7', async () => {
    const t = newTenant();
    const p = newPlayer();
    await h.fund(t, p, 5);
    await h.fund(t, p, 7);
    expect((await h.dbWallet(t, p)).available).toBe(12);
  });

  it('the credited event names the journal transaction, the player and the amount', async () => {
    const t = newTenant();
    const p = newPlayer();
    const spin = uuidv7();
    await h.consume(spinCompleted(t, p, 7, { spinId: spin }));
    const { rows } = await h.admin.query(
      `SELECT envelope FROM outbox WHERE tenant_id = $1 AND type = 'payments.coins.credited'`,
      [t],
    );
    const tx = (
      await h.admin.query(
        `SELECT id FROM journal_transactions WHERE tenant_id = $1 AND operation_id = $2`,
        [t, spin],
      )
    ).rows[0].id;
    expect(parseEvent(rows[0].envelope).payload).toEqual({
      credit_id: tx,
      player_id: p,
      amount: 7,
    });
  });
});

describe('D1-2 the same event delivered concurrently is applied exactly once', () => {
  // Mutation: drop the inbox conflict handling AND the journal unique together (each alone is
  // covered by D1-1 and D1-4).
  it('two consumer instances on two connection pools: one applied, one duplicate', async () => {
    const t = newTenant();
    const p = newPlayer();
    const spin = uuidv7();
    const e = spinCompleted(t, p, 7, { spinId: spin });
    const [a, b] = await Promise.all([
      h.consume(e, { instance: 1 }),
      h.consume(e, { instance: 2 }),
    ]);
    expect([a.outcome, b.outcome].sort()).toEqual(['applied', 'duplicate']);
    expect(await awards(t, spin)).toBe(1);
    expect((await h.dbWallet(t, p)).available).toBe(7);
  });

  it('ten parallel deliveries over both pools: one applied, nine duplicates, coins once', async () => {
    const t = newTenant();
    const p = newPlayer();
    const spin = uuidv7();
    const e = spinCompleted(t, p, 7, { spinId: spin });
    const out = await Promise.all(
      Array.from({ length: 10 }, (_, i) => h.consume(e, { instance: i % 2 === 0 ? 1 : 2 })),
    );
    expect(out.filter((d) => d.outcome === 'applied')).toHaveLength(1);
    expect(out.filter((d) => d.outcome === 'duplicate')).toHaveLength(9);
    expect(out.every((d) => d.acked)).toBe(true);
    expect(await awards(t, spin)).toBe(1);
    expect(await inboxRows(t)).toBe(1);
    expect((await h.dbWallet(t, p)).available).toBe(7);
  });
});

describe('D1-3 redelivery after a restart is still a duplicate', () => {
  // Mutation: keep the dedupe in process memory instead of the inbox table.
  it('close the harness, open a new one, deliver again: duplicate, nothing changes', async () => {
    const t = newTenant();
    const p = newPlayer();
    const e = spinCompleted(t, p, 7);
    expect((await h.consume(e)).outcome).toBe('applied');
    const restarted = await openHarness();
    try {
      const again = await restarted.consume(e);
      expect(again.outcome).toBe('duplicate');
      expect(again.acked).toBe(true);
    } finally {
      await restarted.close();
    }
    expect(await allJournal(t)).toBe(1);
    expect((await h.dbWallet(t, p)).available).toBe(7);
  });
});

describe('D1-4 engagement re-publishes the same spin under a new event id', () => {
  // Mutation: drop UNIQUE (tenant_id, operation_type, operation_id): the defence behind the inbox.
  it('no second credit; the existing transaction answers; inbox has two rows, journal one', async () => {
    const t = newTenant();
    const p = newPlayer();
    const spin = uuidv7();
    await h.consume(spinCompleted(t, p, 7, { spinId: spin }));
    const again = await h.consume(spinCompleted(t, p, 7, { spinId: spin })); // new event_id
    expect(again.outcome).toBe('applied'); // a new inbox row, but no new effect
    expect(again.acked).toBe(true);
    expect(await inboxRows(t)).toBe(2);
    expect(await awards(t, spin)).toBe(1);
    expect(await credited(t)).toBe(1);
    expect((await h.dbWallet(t, p)).available).toBe(7);
  });

  // Reviewer test (Stage B, gap b): the credit is deduped by spin_id, so the meter must be too; the same
  // spin under a new event id is one billable spin. Mutation: meter by event_id.
  it('the re-published spin is metered once, like it is credited once', async () => {
    const t = newTenant();
    const p = newPlayer();
    const spin = uuidv7();
    await h.consume(spinCompleted(t, p, 7, { spinId: spin, at: AT }));
    const again = await h.consume(spinCompleted(t, p, 7, { spinId: spin, at: AT }));
    expect(again.outcome).toBe('applied');
    expect(await awards(t, spin)).toBe(1);
    expect(await spinsMetered(t)).toBe(1);
  });
});

describe('D1-5 the same spin with different parameters is a conflict, not a success', () => {
  // Mutation: return the first result without comparing the parameters.
  it('different reward: dead-lettered with operation_conflict, balance unchanged, never acked', async () => {
    const t = newTenant();
    const p = newPlayer();
    const spin = uuidv7();
    await h.consume(spinCompleted(t, p, 7, { spinId: spin }));
    const bad = await h.consume(spinCompleted(t, p, 9, { spinId: spin }));
    expect(bad.outcome).toBe('rejected');
    expect(bad.deadLettered).toBe(true);
    expect(bad.acked).toBe(false);
    expect(bad.errors[0]).toMatchObject({ code: 'operation_conflict' });
    expect(await inboxRows(t)).toBe(1); // the failed delivery left no inbox row
    expect((await h.dbWallet(t, p)).available).toBe(7);
  });

  it('the same spin for another player is a conflict too', async () => {
    const t = newTenant();
    const spin = uuidv7();
    await h.consume(spinCompleted(t, newPlayer(), 7, { spinId: spin }));
    const bad = await h.consume(spinCompleted(t, newPlayer(), 7, { spinId: spin }));
    expect(bad.outcome).toBe('rejected');
    expect(bad.errors[0]).toMatchObject({ code: 'operation_conflict' });
  });
});

describe('D1-6 inbox row, credit, meter and event commit or roll back together', () => {
  // The hook is driven by the harness, which proves its placement (see ledger.service.pgtest.ts).
  // Mutation: commit the inbox insert or the credit in its own transaction.
  it.each(['after_inbox', 'after_journal', 'after_balance', 'after_outbox'] as const)(
    'a failure %s leaves no inbox row, journal, balance change, event or meter; redelivery applies once',
    async (point) => {
      const t = newTenant();
      const p = newPlayer();
      await h.fund(t, p, 5);
      const before = {
        inbox: await inboxRows(t),
        journal: await allJournal(t),
        out: await n('outbox', t),
        wallet: await h.dbWallet(t, p),
        spins: await spinsMetered(t),
      };
      const e = spinCompleted(t, p, 7, { at: AT });
      const firedBefore = h.faultsFired();
      h.failAt(point);
      const failed = await h.consume(e);
      expect(h.faultsFired()).toBe(firedBefore + 1);
      expect(failed.acked).toBe(false); // never acknowledged after a failure
      expect({
        inbox: await inboxRows(t),
        journal: await allJournal(t),
        out: await n('outbox', t),
        wallet: await h.dbWallet(t, p),
        spins: await spinsMetered(t),
      }).toEqual(before);
      const again = await h.consume(e);
      expect(again.outcome).toBe('applied');
      expect((await h.dbWallet(t, p)).available).toBe(12);
      expect(await spinsMetered(t)).toBe(before.spins + 1);
    },
  );
});

describe('D1-6b a failure AFTER the credit (in metering) rolls the credit back too (reviewer, Stage B)', () => {
  // Every fault hook of D1-6 sits inside `creditSpin`, so a credit committed in its own transaction
  // still rolls back there and D1-6 stays green. Metering runs after the credit in the same delivery.
  // Mutation: run `creditSpin` in its own transaction (`db.tenantTx`) instead of the inbox's.
  it('metering throws: no inbox row, no award, no coins; the redelivery applies once', async () => {
    const t = newTenant();
    const p = newPlayer();
    const e = spinCompleted(t, p, 7, { at: AT });
    const meter = jest
      .spyOn(h.usage, 'handle')
      .mockRejectedValueOnce(new Error('meter failed after the credit'));
    try {
      const failed = await h.consume(e);
      expect(meter).toHaveBeenCalledTimes(1);
      expect(failed.acked).toBe(false);
      expect(await inboxRows(t)).toBe(0);
      expect(await allJournal(t)).toBe(0);
      expect(await credited(t)).toBe(0);
      expect(await n('wallet_owner_links', t)).toBe(0);
    } finally {
      meter.mockRestore();
    }
    expect((await h.consume(e)).outcome).toBe('applied');
    expect((await h.dbWallet(t, p)).available).toBe(7);
    expect(await spinsMetered(t)).toBe(1);
  });
});

describe("D1-7 a transient failure must not lose the player's coins (decision D-9)", () => {
  // Foundation `InboxConsumer.onMessage` rejects WITHOUT requeue on ANY handler error, so today a
  // database blip parks the coins in the dead-letter queue. Decision D-9: a transient error
  // (connection, timeout, deadlock, serialization failure) is retried with bounded backoff; only a
  // permanent error or retry exhaustion goes to the DLQ, which has a replay command (a foundation
  // `bus` change, tested in packages/bus). This test pins the payments side of that contract.
  // Mutation: reject without requeue and without retry on a serialization failure (the foundation today).
  it('a serialization failure is not dead-lettered; the coins arrive exactly once', async () => {
    const t = newTenant();
    const p = newPlayer();
    const e = spinCompleted(t, p, 7);
    h.failAt('after_balance', { transient: true });
    const first = await h.consume(e);
    expect(first.deadLettered).toBe(false);
    if (!first.acked) {
      // Requeued: the broker redelivers; the fault is gone.
      expect(first.requeued).toBe(true);
      expect((await h.consume(e)).outcome).toBe('applied');
    }
    expect(await allJournal(t)).toBe(1);
    expect(await inboxRows(t)).toBe(1);
    expect((await h.dbWallet(t, p)).available).toBe(7);
  });

  // Mutation: retry a permanent error forever, or ack it as a success.
  it('a permanent failure (a type payments does not handle) is dead-lettered at once, nothing recorded', async () => {
    const t = newTenant();
    const e = createEvent({
      type: 'identity.tenant.created',
      tenantId: t,
      payload: { name: 'x', slug: 'x' },
    });
    const d = await h.consume(e);
    expect(d.outcome).toBe('rejected');
    expect(d.deadLettered).toBe(true);
    expect(d.requeued).toBe(false);
    expect(d.acked).toBe(false);
    expect(await inboxRows(t)).toBe(0);
  });
});

describe('D1-8 a spin that rewards nothing', () => {
  // Mutation: credit 0 (hits CHECK amount > 0 and dead-letters a valid event), or skip the meter.
  it('reward_coins = 0: inbox row, no journal transaction, no event, the spin is still metered, acked', async () => {
    const t = newTenant();
    const p = newPlayer();
    const d = await h.consume(spinCompleted(t, p, 0, { at: AT }));
    expect(d.outcome).toBe('applied');
    expect(d.acked).toBe(true);
    expect(await inboxRows(t)).toBe(1);
    expect(await allJournal(t)).toBe(0);
    expect(await credited(t)).toBe(0);
    expect(await spinsMetered(t)).toBe(1);
  });
});

describe('D1-9 the handler trusts only SpinCompletedV1', () => {
  // Mutation: read fields outside the contract, or accept a malformed event.
  it.each([
    ['a fractional reward', { reward_coins: 1.5 }],
    ['a string reward', { reward_coins: '5' }],
    ['a negative reward', { reward_coins: -3 }],
    ['a missing spin_id', { spin_id: undefined }],
    ['a player id that is not a uuid', { player_id: 'p-1' }],
  ])('%s: rejected before anything is recorded', async (_name, payload) => {
    const t = newTenant();
    const d = await h.consume(spinCompleted(t, newPlayer(), 5, { payload }));
    expect(d.outcome).toBe('rejected');
    expect(d.deadLettered).toBe(true);
    expect(await inboxRows(t)).toBe(0);
    expect(await allJournal(t)).toBe(0);
  });

  it('an extra `amount` field in the payload is ignored: the credit is reward_coins', async () => {
    const t = newTenant();
    const p = newPlayer();
    await h.consume(spinCompleted(t, p, 5, { payload: { amount: 999_999 } }));
    expect((await h.dbWallet(t, p)).available).toBe(5);
  });
});

describe('D1-10 the tenant comes from the envelope only', () => {
  // Mutation: key the business operation without tenant_id.
  it('the same spin_id in tenants A and B is two independent credits, nothing of A visible to B', async () => {
    const a = newTenant();
    const b = newTenant();
    const pa = newPlayer();
    const pb = newPlayer();
    const spin = uuidv7();
    expect((await h.consume(spinCompleted(a, pa, 7, { spinId: spin }))).outcome).toBe('applied');
    expect((await h.consume(spinCompleted(b, pb, 3, { spinId: spin }))).outcome).toBe('applied');
    expect((await h.dbWallet(a, pa)).available).toBe(7);
    expect((await h.dbWallet(b, pb)).available).toBe(3);
    expect(await awards(a, spin)).toBe(1);
    expect(await awards(b, spin)).toBe(1);
    await expect(h.as(b, () => h.balances.readByPlayer(pa))).rejects.toMatchObject({
      code: 'wallet_not_found',
    });
  });
});

describe('D1-11 the first spins of a new player, in parallel, make one wallet (MIO-084, F7)', () => {
  // Mutation: create the wallet or a tenant system account with a plain INSERT, without the unique
  // constraints and `ON CONFLICT DO NOTHING` + re-select.
  it('20 different spins at once in a new tenant: one wallet, one link, one issuance account, balance = sum', async () => {
    const t = newTenant();
    const p = newPlayer();
    const rewards = Array.from({ length: 20 }, (_, i) => i + 1);
    const out = await Promise.all(
      rewards.map((r, i) => h.consume(spinCompleted(t, p, r), { instance: i % 2 === 0 ? 1 : 2 })),
    );
    expect(out.map((d) => d.outcome)).toEqual(rewards.map(() => 'applied'));
    expect(await n('wallets', t)).toBe(1);
    expect(await n('wallet_owner_links', t)).toBe(1);
    expect(await n('accounts', t, `AND kind = 'tenant_issuance'`)).toBe(1);
    expect(await n('accounts', t, `AND kind = 'player_available'`)).toBe(1);
    expect(await n('accounts', t, `AND kind = 'player_held'`)).toBe(1);
    expect((await h.dbWallet(t, p)).available).toBe(210);
  });

  it('two new players at once share the tenant system accounts', async () => {
    const t = newTenant();
    await Promise.all([
      h.consume(spinCompleted(t, newPlayer(), 4)),
      h.consume(spinCompleted(t, newPlayer(), 6)),
    ]);
    expect(await n('wallets', t)).toBe(2);
    expect(await n('accounts', t, `AND kind = 'tenant_issuance'`)).toBe(1);
    expect(await n('accounts', t, `AND kind = 'tenant_redeemed'`)).toBe(1);
  });
});

describe('D1-12 credit and metering share one delivery', () => {
  // Mutation: meter in a second transaction, or under a second consumer key without dedupe.
  it('one delivery gives one credit and one spin; a redelivery changes neither', async () => {
    const t = newTenant();
    const p = newPlayer();
    const e = spinCompleted(t, p, 7, { at: AT });
    await h.consume(e);
    expect(await spinsMetered(t)).toBe(1);
    expect(await n('usage_events', t)).toBe(1);
    await h.consume(e);
    expect(await spinsMetered(t)).toBe(1);
    expect(await n('usage_events', t)).toBe(1);
    expect((await h.dbWallet(t, p)).available).toBe(7);
  });
});

describe('D1-13 the Redis projection follows the event, eventually', () => {
  // Mutation: have the spin path write, invalidate or read the cache.
  it('the spin path never touches the cache; the read catches up once onCoinEvent runs', async () => {
    const t = newTenant();
    const p = newPlayer();
    h.cache.store.clear();
    h.cache.calls.length = 0;
    await h.consume(spinCompleted(t, p, 5));
    expect(h.cache.calls).toEqual([]);
    expect(await h.as(t, () => h.balances.readByPlayer(p))).toMatchObject({ available: 5 });
    const afterRead = [...h.cache.calls];
    await h.consume(spinCompleted(t, p, 7));
    expect(h.cache.calls).toEqual(afterRead); // the second spin added no cache call at all
    // Eventually consistent: the cached 5 is still served until the event is applied.
    expect(await h.as(t, () => h.balances.readByPlayer(p))).toMatchObject({ available: 5 });
    const { rows } = await h.admin.query(
      `SELECT envelope FROM outbox WHERE tenant_id = $1 AND type = 'payments.coins.credited' ORDER BY created_at DESC, event_id DESC LIMIT 1`,
      [t],
    );
    await h.as(t, () => h.balances.onCoinEvent(parseEvent(rows[0].envelope)));
    expect(await h.as(t, () => h.balances.readByPlayer(p))).toMatchObject({ available: 12 });
  });
});

describe('X-2 a sandbox spin never credits the production wallet (D-15, D-13; reviewer, Stage B gap a)', () => {
  // Choke point: the inbox handler and `LedgerService.creditSpin`, read back through the two production
  // readers of a wallet: the coin reserve (what a redemption can spend) and the balance read API.
  // The sandbox flag is set by the producer on the envelope (D-13); payments keeps separate sandbox
  // wallets (D-15). The sandbox coins may live anywhere EXCEPT where production can spend or show them.
  // Mutation: credit a sandbox spin like a production one (today: `creditSpin` never reads the flag).
  const reserveOf = (t: string, p: string, amount: number) =>
    h.as(t, () =>
      h.ledger.reserve(
        { player_id: p, reserve_id: uuidv7(), amount, currency: 'COIN' },
        `x2-${uuidv7()}`,
      ),
    );
  const productionAvailable = async (t: string, p: string): Promise<number> => {
    h.cache.store.clear(); // read the database, not a value cached by an earlier test
    try {
      return (await h.as(t, () => h.balances.readByPlayer(p))).available;
    } catch (err) {
      expect(err).toMatchObject({ code: 'wallet_not_found' });
      return 0;
    }
  };

  it('a new player with only a sandbox spin: delivered and acked, production shows and spends nothing', async () => {
    const t = newTenant();
    const p = newPlayer();
    const d = await h.consume(spinCompletedIn(true, t, p, 50));
    expect(d.outcome).toBe('applied'); // not lost, not dead-lettered
    expect(d.acked).toBe(true);
    expect(await productionAvailable(t, p)).toBe(0);
    await expect(reserveOf(t, p, 1)).rejects.toMatchObject({ code: 'insufficient_funds' });
  });

  it('production 3 and sandbox 50 for one player: production can spend 3 and not a coin more', async () => {
    const t = newTenant();
    const p = newPlayer();
    await h.fund(t, p, 3);
    await h.consume(spinCompletedIn(true, t, p, 50));
    expect(await productionAvailable(t, p)).toBe(3);
    await expect(reserveOf(t, p, 4)).rejects.toMatchObject({ code: 'insufficient_funds' });
    await expect(reserveOf(t, p, 3)).resolves.toMatchObject({ body: { amount: 3 } });
  });

  // Mutation: publish the sandbox credit as a plain `payments.coins.credited` (the projection and every
  // other consumer would then take it for production coins).
  it('every event the sandbox credit publishes is marked sandbox by payments, the producer', async () => {
    const t = newTenant();
    const p = newPlayer();
    await h.consume(spinCompletedIn(true, t, p, 50));
    const { rows } = await h.admin.query(`SELECT envelope FROM outbox WHERE tenant_id = $1`, [t]);
    for (const r of rows) expect(parseEvent(r.envelope).sandbox).toBe(true);
  });
});
