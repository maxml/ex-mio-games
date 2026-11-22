import { IdempotencyMismatchError } from '@ex-mio/idempotency';
import {
  RESERVE_COMMAND_OUTCOMES,
  RESERVE_STATES,
  parseEvent,
  uuidv7,
  type EventEnvelope,
  type ReserveState,
} from '@ex-mio/contracts';
import {
  key,
  newPlayer,
  newTenant,
  openHarness,
  spinCompleted,
  spinCompletedIn,
  type Harness,
} from '../testing/harness';
import { withRowLocked } from '../testing/pg';
import { LedgerError } from './ledger.errors';

// Choke point: `LedgerService` (one database transaction per command) over the real database.
// Each test names the mutation that must turn it red. Spec: docs/specs/payments.md, section 5.
//
// Wallets are funded and read the way the system does it: coins arrive only as `spin.completed`
// through the inbox (`h.fund`), and balances are read straight from the tables (`h.dbWallet`), never
// through BalanceService, whose cache a command must not touch (spec section 6, decision D-9).

let h: Harness;
beforeAll(async () => {
  h = await openHarness();
});
afterAll(async () => h.close());

const reserve = (t: string, player: string, amount: number, id = uuidv7(), k = key('reserve')) =>
  h.as(t, () =>
    h.ledger.reserve(
      { player_id: player, reserve_id: id, amount, currency: 'COIN', sandbox: false },
      k,
    ),
  );
const capture = (t: string, id: string, k = key('capture')) =>
  h.as(t, () => h.ledger.capture({ reserve_id: id }, k));
const release = (t: string, id: string, k = key('release')) =>
  h.as(t, () => h.ledger.release({ reserve_id: id }, k));
const refund = (t: string, id: string, k = key('refund')) =>
  h.as(t, () => h.ledger.refund({ reserve_id: id }, k));

const COMMANDS = { capture, release, refund } as const;

async function count(table: string, tenant: string, where = ''): Promise<number> {
  const { rows } = await h.admin.query(
    `SELECT count(*)::int AS n FROM ${table} WHERE tenant_id = $1 ${where}`,
    [tenant],
  );
  return rows[0].n;
}

const journalOf = (tenant: string, type: string, operationId?: string) =>
  count(
    'journal_transactions',
    tenant,
    `AND operation_type = '${type}'${operationId ? ` AND operation_id = '${operationId}'` : ''}`,
  );

async function outbox(tenant: string): Promise<EventEnvelope[]> {
  const { rows } = await h.admin.query(
    `SELECT envelope FROM outbox WHERE tenant_id = $1 ORDER BY created_at, event_id`,
    [tenant],
  );
  return rows.map((r) => parseEvent(r.envelope));
}

const lockBalanceRow = `SELECT b.amount FROM balances b
   JOIN accounts a ON a.tenant_id = b.tenant_id AND a.id = b.account_id
  WHERE b.tenant_id = $1 AND a.wallet_id = $2 AND a.kind = 'player_available' FOR UPDATE OF b`;

describe('INV-C1 concurrent reserves never overspend', () => {
  // Mutation: read the balance first and write `available = <value read>` (read-then-write),
  // or drop the `AND amount >= $n` guard from the conditional update.
  it('50 parallel reserves, all in flight before any write lands, against 7: exactly 7 succeed', async () => {
    const t = newTenant();
    const p = newPlayer();
    await h.fund(t, p, 7);
    const w = await h.dbWallet(t, p);
    // A real pool, not a serialised one: a Stage B `max: 1` or a process mutex fails here (F14).
    expect(h.poolMax()).toBeGreaterThanOrEqual(10);
    const { result: results, peakOpenTransactions } = await withRowLocked(
      h.admin,
      lockBalanceRow,
      [t, w.wallet_id],
      () => Promise.allSettled(Array.from({ length: 50 }, () => reserve(t, p, 1))),
    );
    expect(peakOpenTransactions).toBeGreaterThanOrEqual(5); // the contenders really overlapped
    const ok = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
    expect(ok).toHaveLength(7);
    expect(rejected).toHaveLength(43);
    for (const r of rejected) expect(r.reason).toMatchObject({ code: 'insufficient_funds' });
    expect(await h.dbWallet(t, p)).toMatchObject({ available: 0, held: 7 });
  });
});

describe('INV-C1b the same property with ONE connection, caught from the SQL itself', () => {
  // With a pool of one, a read-then-write implementation is serialised into being correct, so the
  // outcome cannot expose it. The statements can: every balance decrease must be a guarded,
  // relative UPDATE; no read of a balance may decide it first.
  // Mutation: read the balance (a plain SELECT), compute in JS, write an absolute value, or drop the guard.
  it('exactly 7 of 50 succeed and every balance write is a conditional relative UPDATE', async () => {
    const one = await openHarness({ poolMax: 1, captureSql: true });
    try {
      const t = newTenant();
      const p = newPlayer();
      await one.fund(t, p, 7);
      one.sql.length = 0;
      const results = await Promise.allSettled(
        Array.from({ length: 50 }, () =>
          one.as(t, () =>
            one.ledger.reserve(
              { player_id: p, reserve_id: uuidv7(), amount: 1, currency: 'COIN', sandbox: false },
              key('reserve'),
            ),
          ),
        ),
      );
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(7);
      expect(one.poolMax()).toBe(1);

      const statements = one.sql.map((s) => s.replace(/"/g, '').replace(/\s+/g, ' ').trim());
      const decreases = statements.filter((s) =>
        /^UPDATE balances SET amount = .*amount\s*-/i.test(s),
      );
      expect(decreases.length).toBeGreaterThanOrEqual(7);
      for (const s of decreases) expect(s).toMatch(/amount\s*>=\s*\$\d+/i);
      for (const s of statements.filter((x) => /^UPDATE balances/i.test(x))) {
        expect(s).not.toMatch(/SET amount = \$\d+/i); // no absolute write
      }
      // Within one transaction no unlocked SELECT of balances may come before the first balance UPDATE.
      let readFirst = false;
      let updated = false;
      for (const s of statements) {
        if (/^START TRANSACTION/i.test(s)) {
          updated = false;
        } else if (/^UPDATE balances/i.test(s)) {
          updated = true;
        } else if (!updated && /^SELECT .* FROM balances/i.test(s) && !/FOR UPDATE/i.test(s)) {
          readFirst = true;
        }
      }
      expect(readFirst).toBe(false);
    } finally {
      await one.close();
    }
  });
});

describe('INV-C2 mixed concurrent credits and reserves conserve the total', () => {
  // Mutation: compute the new balance from a value read before the transaction (lost update).
  it('100 parallel spin credits (through the inbox) and reserves: available + held == start + credited', async () => {
    const t = newTenant();
    const p = newPlayer();
    await h.fund(t, p, 20);
    const ops = Array.from({ length: 100 }, (_, i) =>
      i % 2 === 0
        ? h
            .consume(spinCompleted(t, p, 3))
            .then((d) => (d.outcome === 'applied' ? 'credit' : 'lost'))
        : reserve(t, p, 1).then(() => 'reserve' as const),
    );
    const settled = await Promise.allSettled(ops);
    const credits = settled.filter((r) => r.status === 'fulfilled' && r.value === 'credit').length;
    const reserves = settled.filter(
      (r) => r.status === 'fulfilled' && r.value === 'reserve',
    ).length;
    expect(credits).toBe(50); // a credit cannot fail
    const w = await h.dbWallet(t, p);
    expect(w.available + w.held).toBe(20 + 3 * credits);
    expect(w.held).toBe(reserves);
    expect(w.available).toBeGreaterThanOrEqual(0);
  });
});

describe('INV-I1 the same key and body replays one effect', () => {
  // Mutation: skip runIdempotent (or write the idempotency row in a second transaction).
  it('reserve twice with one key reserves once and returns the same response', async () => {
    const t = newTenant();
    const p = newPlayer();
    await h.fund(t, p, 10);
    const id = uuidv7();
    const k = key('reserve');
    const first = await reserve(t, p, 4, id, k);
    const second = await reserve(t, p, 4, id, k);
    expect(second.replayed).toBe(true);
    expect(second.body).toEqual(first.body);
    expect(await journalOf(t, 'reserve')).toBe(1);
    expect(await h.dbWallet(t, p)).toMatchObject({ available: 6, held: 4 });
  });
});

describe('INV-I2 the same key with a changed body is refused and executes nothing', () => {
  // Mutation: drop the request-hash comparison in the idempotency check.
  it('422 idempotency_key_reused, journal unchanged', async () => {
    const t = newTenant();
    const p = newPlayer();
    await h.fund(t, p, 10);
    const id = uuidv7();
    const k = key('reserve');
    await reserve(t, p, 4, id, k);
    await expect(reserve(t, p, 5, id, k)).rejects.toBeInstanceOf(IdempotencyMismatchError);
    expect(await journalOf(t, 'reserve')).toBe(1);
    expect(await h.dbWallet(t, p)).toMatchObject({ available: 6, held: 4 });
  });
});

describe('INV-I3 replay after the HTTP idempotency record expired still has no second effect', () => {
  // Mutation: drop UNIQUE (tenant_id, operation_type, operation_id), or derive operation_id from the key.
  // Reviewer fix (Stage B): D-9 makes a command idempotent by the reserve's CURRENT state, and
  // RESERVE_COMMAND_OUTCOMES is that rule. A late repeat replays only while the reserve still sits in the
  // state the command leads to; once a later phase moved it on (capture, then refund), a late capture is
  // the table's conflict code, never a second effect. The old version of this test replayed capture on a
  // refunded reserve and so contradicted INV-T1 and the contract table.
  it('every phase, new key, record purged: the first transaction is returned (MIO-150-16)', async () => {
    const t = newTenant();
    const p = newPlayer();
    await h.fund(t, p, 20);
    const a = uuidv7(); // ends captured
    const b = uuidv7(); // ends released
    const c = uuidv7(); // ends refunded
    const rsvA = await reserve(t, p, 4, a);
    const capA = await capture(t, a);
    await reserve(t, p, 3, b);
    const relB = await release(t, b);
    await reserve(t, p, 2, c);
    await capture(t, c);
    const refC = await refund(t, c);
    const journal = await count('journal_transactions', t);
    const wallet = await h.dbWallet(t, p);
    const events = (await outbox(t)).length;
    await h.admin.query(`DELETE FROM idempotency_keys WHERE tenant_id = $1`, [t]);
    expect(await count('idempotency_keys', t)).toBe(0);

    const again = {
      reserve: await reserve(t, p, 4, a, key('late')),
      capture: await capture(t, a, key('late')),
      release: await release(t, b, key('late')),
      refund: await refund(t, c, key('late')),
    };
    expect(again.reserve.body.transaction_id).toBe(rsvA.body.transaction_id);
    expect(again.capture.body.transaction_id).toBe(capA.body.transaction_id);
    expect(again.release.body.transaction_id).toBe(relB.body.transaction_id);
    expect(again.refund.body.transaction_id).toBe(refC.body.transaction_id);
    for (const r of Object.values(again)) expect(r.replayed).toBe(false); // the HTTP record is gone
    expect(await count('journal_transactions', t)).toBe(journal);
    expect(await h.dbWallet(t, p)).toEqual(wallet);
    expect((await outbox(t)).length).toBe(events); // a state replay does not publish again
  });

  // Mutation: answer a late command from the journal alone ("was this phase ever applied?") instead of
  // from the reserve's current state, or move the reserve without `WHERE state = <expected>`.
  it('record purged, a later phase already applied: the late command gets the table code, no effect', async () => {
    const t = newTenant();
    const p = newPlayer();
    await h.fund(t, p, 10);
    const c = uuidv7();
    await reserve(t, p, 4, c);
    await capture(t, c);
    await refund(t, c);
    const journal = await count('journal_transactions', t);
    const wallet = await h.dbWallet(t, p);
    const events = (await outbox(t)).length;
    await h.admin.query(`DELETE FROM idempotency_keys WHERE tenant_id = $1`, [t]);

    for (const cmd of ['capture', 'release'] as const) {
      await expect(COMMANDS[cmd](t, c, key('late'))).rejects.toMatchObject({
        code: RESERVE_COMMAND_OUTCOMES.refunded[cmd],
      });
    }
    expect(await count('journal_transactions', t)).toBe(journal);
    expect(await h.dbWallet(t, p)).toEqual(wallet);
    expect((await outbox(t)).length).toBe(events);
  });

  // Mutation: return the first result without comparing the parameters.
  it('the same reserve id with another amount, or another player, is operation_conflict', async () => {
    const t = newTenant();
    const p = newPlayer();
    const other = newPlayer();
    await h.fund(t, p, 10);
    await h.fund(t, other, 10);
    const id = uuidv7();
    await reserve(t, p, 4, id);
    await expect(reserve(t, p, 5, id, key('other'))).rejects.toMatchObject({
      code: 'operation_conflict',
    });
    await expect(reserve(t, other, 4, id, key('other'))).rejects.toMatchObject({
      code: 'operation_conflict',
    });
    expect(await journalOf(t, 'reserve')).toBe(1);
  });
});

describe('INV-I4 one business operation in parallel under different keys is one effect', () => {
  // Mutation: look the operation up with a SELECT before inserting (check-then-act) and drop the
  // unique constraint, or treat a unique violation as an error instead of returning the first result.
  it('the same reserve id under 10 different keys at once: one transaction, ten identical answers', async () => {
    const t = newTenant();
    const p = newPlayer();
    await h.fund(t, p, 10);
    const id = uuidv7();
    const answers = await Promise.all(Array.from({ length: 10 }, () => reserve(t, p, 4, id)));
    expect(new Set(answers.map((a) => a.body.transaction_id)).size).toBe(1);
    expect(await journalOf(t, 'reserve', id)).toBe(1);
    expect(await h.dbWallet(t, p)).toMatchObject({ available: 6, held: 4 });
  });
});

type Setup = { id: string; tx: Partial<Record<ReserveState, string>> };

/** Bring a fresh reserve of 4 (wallet funded with 10) into `state`, remembering each transition's transaction id. */
async function reserveIn(t: string, p: string, state: ReserveState): Promise<Setup> {
  const id = uuidv7();
  const tx: Setup['tx'] = {};
  tx.reserved = (await reserve(t, p, 4, id)).body.transaction_id;
  if (state === 'captured' || state === 'refunded')
    tx.captured = (await capture(t, id)).body.transaction_id;
  if (state === 'released') tx.released = (await release(t, id)).body.transaction_id;
  if (state === 'refunded') tx.refunded = (await refund(t, id)).body.transaction_id;
  return { id, tx };
}

describe('INV-T1 reserve transitions follow the contract table; conflicts carry their own code', () => {
  // The expected outcome of every (state, command) pair is RESERVE_COMMAND_OUTCOMES from the
  // contracts package, which the contracts test ties to ALLOWED_RESERVE_TRANSITIONS.
  // Mutation: remove the `WHERE state = <expected>` guard, answer any conflict with one generic code,
  // or turn a repeat into an error.
  const cases = RESERVE_STATES.flatMap((state) =>
    (['capture', 'release', 'refund'] as const).map(
      (cmd) => [state, cmd, RESERVE_COMMAND_OUTCOMES[state][cmd]] as const,
    ),
  );
  it.each(cases)('a %s reserve receives %s: %s', async (state, cmd, outcome) => {
    const t = newTenant();
    const p = newPlayer();
    await h.fund(t, p, 10);
    const s = await reserveIn(t, p, state);
    const journal = await count('journal_transactions', t);
    const wallet = await h.dbWallet(t, p);

    const run = () => COMMANDS[cmd](t, s.id, key('again'));
    if (outcome === 'apply') {
      const res = await run();
      expect(res.body.operation).toBe(cmd);
      expect(await count('journal_transactions', t)).toBe(journal + 1);
    } else if (outcome === 'replay') {
      const res = await run();
      const original = { capture: s.tx.captured, release: s.tx.released, refund: s.tx.refunded }[
        cmd
      ];
      expect(res.body.transaction_id).toBe(original);
      expect(await count('journal_transactions', t)).toBe(journal);
      expect(await h.dbWallet(t, p)).toEqual(wallet);
    } else {
      await expect(run()).rejects.toMatchObject({ code: outcome });
      expect(await count('journal_transactions', t)).toBe(journal);
      expect(await h.dbWallet(t, p)).toEqual(wallet);
    }
  });

  it('release returns the available balance to its starting value', async () => {
    const t = newTenant();
    const p = newPlayer();
    await h.fund(t, p, 10);
    const id = uuidv7();
    await reserve(t, p, 10, id);
    expect(await h.dbWallet(t, p)).toMatchObject({ available: 0, held: 10 });
    await release(t, id);
    expect(await h.dbWallet(t, p)).toMatchObject({ available: 10, held: 0 });
  });

  it('capture spends the held coins; refund returns exactly those coins', async () => {
    const t = newTenant();
    const p = newPlayer();
    await h.fund(t, p, 10);
    const id = uuidv7();
    await reserve(t, p, 4, id);
    await capture(t, id);
    expect(await h.dbWallet(t, p)).toMatchObject({ available: 6, held: 0 });
    await refund(t, id);
    expect(await h.dbWallet(t, p)).toMatchObject({ available: 10, held: 0 });
  });

  // Mutation: look the reserve up without the tenant filter / outside RLS.
  it("an unknown reserve id, and another tenant's reserve id, are reserve_not_found for every command", async () => {
    const t = newTenant();
    const other = newTenant();
    const p = newPlayer();
    await h.fund(other, p, 10);
    const id = uuidv7();
    await reserve(other, p, 4, id);
    for (const cmd of Object.values(COMMANDS)) {
      await expect(cmd(t, uuidv7())).rejects.toMatchObject({ code: 'reserve_not_found' });
      await expect(cmd(t, id)).rejects.toMatchObject({ code: 'reserve_not_found' });
    }
    expect(await h.dbWallet(other, p)).toMatchObject({ available: 6, held: 4 });
  });
});

describe('INV-T2 each phase is idempotent by the state of the reserve, whatever the HTTP key', () => {
  // Mutation: let a phase insert a second journal transaction (drop the per-phase operation key), or
  // answer a repeat with a conflict. L4 sends a late duplicate capture after the key expired; a 409
  // there would push a completed redemption into manual review (decision D-9, MIO-066, MIO-150-15).
  it('capture: same key replays; a new key returns the stored result; the balance moves once', async () => {
    const t = newTenant();
    const p = newPlayer();
    await h.fund(t, p, 10);
    const id = uuidv7();
    await reserve(t, p, 4, id);
    const k = key('capture');
    const first = await capture(t, id, k);
    const same = await capture(t, id, k);
    expect(same.replayed).toBe(true);
    expect(same.body).toEqual(first.body);
    const later = await capture(t, id, key('capture-again'));
    expect(later.body).toMatchObject({
      transaction_id: first.body.transaction_id,
      operation: 'capture',
      reserve_id: id,
      amount: 4,
    });
    expect(await journalOf(t, 'capture', id)).toBe(1);
    expect(await h.dbWallet(t, p)).toMatchObject({ available: 6, held: 0 });
  });

  it('release repeated three times, refund repeated three times: one transaction each (MIO-150-15)', async () => {
    const t = newTenant();
    const p = newPlayer();
    await h.fund(t, p, 10);
    const a = uuidv7();
    const b = uuidv7();
    await reserve(t, p, 3, a);
    await reserve(t, p, 4, b);
    const releases = [await release(t, a), await release(t, a), await release(t, a)];
    expect(new Set(releases.map((r) => r.body.transaction_id)).size).toBe(1);
    await capture(t, b);
    const refunds = [await refund(t, b), await refund(t, b), await refund(t, b)];
    expect(new Set(refunds.map((r) => r.body.transaction_id)).size).toBe(1);
    expect(await journalOf(t, 'release', a)).toBe(1);
    expect(await journalOf(t, 'refund', b)).toBe(1);
    expect(await h.dbWallet(t, p)).toMatchObject({ available: 10, held: 0 });
  });
});

describe('INV-T3 a reserve id is explicit and reserves once', () => {
  // Mutation: generate the reserve id inside payments instead of taking it from the command.
  it('the same reserve id with another key and the same body returns the first reserve', async () => {
    const t = newTenant();
    const p = newPlayer();
    await h.fund(t, p, 10);
    const id = uuidv7();
    const first = await reserve(t, p, 4, id);
    const again = await reserve(t, p, 4, id, key('retry'));
    expect(first.body.reserve_id).toBe(id);
    expect(again.body.transaction_id).toBe(first.body.transaction_id);
    expect(await h.dbWallet(t, p)).toMatchObject({ available: 6, held: 4 });
  });

  it('a reserve above the balance is insufficient_funds and leaves no reserve row', async () => {
    const t = newTenant();
    const p = newPlayer();
    await h.fund(t, p, 3);
    const id = uuidv7();
    await expect(reserve(t, p, 4, id)).rejects.toMatchObject({ code: 'insufficient_funds' });
    expect(await count('reserves', t)).toBe(0);
    await expect(capture(t, id)).rejects.toMatchObject({ code: 'reserve_not_found' });
  });
});

describe('INV-T4 capture and release of one reserve race: exactly one transition wins', () => {
  // The journal's unique key is per operation type, so capture and release do not collide there.
  // Mutation: read the reserve state with a SELECT, check it in JS, then UPDATE without
  // `WHERE state = 'reserved'`. A second open reserve hides the damage from the held-balance CHECK.
  it('20 mixed calls under distinct keys: one transition, the rest replay or conflict; held is 4; B is untouched', async () => {
    const t = newTenant();
    const p = newPlayer();
    await h.fund(t, p, 10);
    const a = uuidv7();
    const b = uuidv7();
    await reserve(t, p, 4, a);
    await reserve(t, p, 4, b);
    expect(await h.dbWallet(t, p)).toMatchObject({ available: 2, held: 8 });

    const { result, peakOpenTransactions } = await withRowLocked(
      h.admin,
      `SELECT 1 FROM reserves WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
      [t, a],
      () =>
        Promise.allSettled(
          Array.from({ length: 20 }, (_, i) => (i % 2 === 0 ? capture(t, a) : release(t, a))),
        ),
    );
    expect(peakOpenTransactions).toBeGreaterThanOrEqual(5);
    const won = (await journalOf(t, 'capture', a)) + (await journalOf(t, 'release', a));
    expect(won).toBe(1);
    const winner = (await journalOf(t, 'capture', a)) === 1 ? 'capture' : 'release';
    const loserCode =
      winner === 'capture' ? 'reserve_already_captured' : 'reserve_already_released';
    const fulfilled = result.filter((r) => r.status === 'fulfilled');
    const rejected = result.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
    expect(fulfilled).toHaveLength(10); // every call of the winning kind
    expect(
      new Set(
        fulfilled.map(
          (r) =>
            (r as PromiseFulfilledResult<{ body: { transaction_id: string } }>).value.body
              .transaction_id,
        ),
      ).size,
    ).toBe(1);
    expect(rejected).toHaveLength(10);
    for (const r of rejected) expect(r.reason).toMatchObject({ code: loserCode });

    const w = await h.dbWallet(t, p);
    expect(w.held).toBe(4); // only A left; B is still backed
    expect(w.available).toBe(winner === 'capture' ? 2 : 6);
    await expect(capture(t, b)).resolves.toBeDefined();
    expect(await h.dbWallet(t, p)).toMatchObject({ held: 0 });
  });
});

describe('INV-A1 effect, ledger and outbox commit or roll back together', () => {
  // The fault hook is driven by the harness: before it throws it proves, through the transaction the
  // code passed in, that the write it follows is visible there and not yet committed. A hook placed
  // before the write fails the test with "misplaced fault hook".
  // Mutation: commit the journal before the balance update / outbox insert (second transaction),
  // call the hooks before their writes, or catch the error and carry on.
  const points = ['after_journal', 'after_balance', 'after_outbox'] as const;
  const phases = ['reserve', 'capture', 'release', 'refund'] as const;
  const cases = phases.flatMap((phase) => points.map((point) => [phase, point] as const));

  it.each(cases)(
    '%s failing %s leaves nothing, and the retry applies exactly once',
    async (phase, point) => {
      const t = newTenant();
      const p = newPlayer();
      await h.fund(t, p, 10);
      const id = uuidv7();
      // Put the reserve in the state the phase starts from.
      if (phase !== 'reserve') await reserve(t, p, 4, id);
      if (phase === 'refund') await capture(t, id);
      const call = (k: string) =>
        phase === 'reserve' ? reserve(t, p, 4, id, k) : COMMANDS[phase](t, id, k);

      const snap = async () => ({
        journal: await count('journal_transactions', t),
        entries: await count('ledger_entries', t),
        idem: await count('idempotency_keys', t),
        out: await count('outbox', t),
        reserves: await count('reserves', t),
        states: (
          await h.admin.query(`SELECT id, state FROM reserves WHERE tenant_id = $1 ORDER BY id`, [
            t,
          ])
        ).rows,
        wallet: await h.dbWallet(t, p),
      });
      const before = await snap();
      const firedBefore = h.faultsFired();
      const k = key(phase);
      h.failAt(point);
      await expect(call(k)).rejects.toThrow(/injected fault/);
      expect(h.faultsFired()).toBe(firedBefore + 1); // the hook was reached, and proved its placement
      expect(await snap()).toEqual(before);
      // The failed attempt did not poison the key.
      const retry = await call(k);
      expect(retry.replayed).toBe(false);
      expect(await count('journal_transactions', t)).toBe(before.journal + 1);
    },
  );

  // Mutation: let a LedgerError-style catch turn a failure into a defined-but-wrong answer.
  it('a failure is never answered as success, and is not a domain error', async () => {
    const t = newTenant();
    const p = newPlayer();
    await h.fund(t, p, 10);
    h.failAt('after_balance');
    const err = await reserve(t, p, 2).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(LedgerError);
  });
});

describe('INV-E1 every phase writes its event in the same transaction', () => {
  // Mutation: do not enqueue the event for one phase, or enqueue it outside the effect transaction.
  it('credit, reserve, capture, refund, reserve, release: one event each with the balances after', async () => {
    const t = newTenant();
    const p = newPlayer();
    await h.fund(t, p, 10);
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

  it('a replay (same key, or a repeated phase under a new key) does not enqueue a second event', async () => {
    const t = newTenant();
    const p = newPlayer();
    await h.fund(t, p, 10);
    const id = uuidv7();
    const k = key('reserve');
    await reserve(t, p, 4, id, k);
    await reserve(t, p, 4, id, k);
    await capture(t, id);
    await capture(t, id, key('again'));
    expect(await outbox(t)).toHaveLength(3); // credited, reserved, captured
  });
});

describe('INV-X4 hostile strings reach the database only as parameters (MIO-150-12)', () => {
  // Mutation: build any SQL by interpolating a request value. (A source scan in sql-safety.test.ts
  // forbids interpolation in query text altogether.)
  it('an idempotency key full of quotes and SQL is stored and replayed verbatim; the tables survive', async () => {
    const t = newTenant();
    const p = newPlayer();
    await h.fund(t, p, 10);
    const nasty = `k'); DROP TABLE reserves; --"\\`;
    const id = uuidv7();
    const first = await reserve(t, p, 4, id, nasty);
    const second = await reserve(t, p, 4, id, nasty);
    expect(second.replayed).toBe(true);
    expect(second.body).toEqual(first.body);
    const { rows } = await h.admin.query(`SELECT to_regclass('public.reserves') AS r`);
    expect(rows[0].r).toBe('reserves');
    expect(await count('reserves', t)).toBe(1);
  });
});

describe('INV-O2 erasing the identity link keeps the stable account', () => {
  // Mutation: make eraseIdentityLink delete the wallet or its entries, or leave the link in place.
  it('the link is gone, the wallet id still reads its balance, the player id no longer resolves', async () => {
    const t = newTenant();
    const p = newPlayer();
    await h.fund(t, p, 10);
    const walletId = (await h.dbWallet(t, p)).wallet_id;
    // INV-ENV-INPUT (D-29): the environment is a required read input; `h.fund` is production.
    // Control: before the erase the player DOES resolve in that environment, so the
    // wallet_not_found below is the erase, not a read that could never resolve.
    const prod = { sandbox: false } as const;
    expect(await h.as(t, () => h.balances.readByPlayer(p, prod))).toMatchObject({
      wallet_id: walletId,
    });
    await h.as(t, () => h.ledger.eraseIdentityLink(p));
    expect(await count('wallet_owner_links', t)).toBe(0);
    expect(await h.as(t, () => h.balances.readByWallet(walletId))).toMatchObject({ available: 10 });
    await expect(h.as(t, () => h.balances.readByPlayer(p, prod))).rejects.toMatchObject({
      code: 'wallet_not_found',
    });
    expect(await count('ledger_entries', t)).toBe(2);
  });
});

// X-2 / D-13: a sandbox flag must never touch production coins, and it must not remove a paid
// operation from the bill. A player has one wallet per environment; the environment of a credit
// is the envelope flag, of a reserve the request flag, and capture, release and refund use the
// reserve's own wallet.
describe('INV-SBX sandbox effects use separate sandbox wallets', () => {
  // Mutation: pick the wallet by (tenant, player) alone, or ignore envelope.sandbox on the credit.
  it('INV-SBX-1 a sandbox spin credits the SANDBOX wallet; the production balance is unchanged and nothing is metered', async () => {
    const t = newTenant();
    const p = newPlayer();
    await h.fund(t, p, 10); // production
    const d = await h.consume(spinCompletedIn(true, t, p, 7, { at: '2026-11-05T10:00:00.000Z' }));
    expect(d.outcome).toBe('applied');
    expect((await h.dbWallet(t, p)).available).toBe(10);
    expect((await h.dbWalletIn(t, p, true)).available).toBe(7);
    expect(await count('wallets', t)).toBe(2);
    const { rows } = await h.admin.query(
      `SELECT count(*)::int AS n FROM usage_events WHERE tenant_id = $1 AND occurred_at >= '2026-11-01'`,
      [t],
    );
    expect(rows[0].n).toBe(0);
  });

  // Mutation: let a sandbox reserve read or debit the production wallet.
  it('INV-SBX-2 a reserve against the sandbox wallet cannot spend production coins', async () => {
    const t = newTenant();
    const p = newPlayer();
    await h.fund(t, p, 10); // production only
    await expect(
      h.as(t, () =>
        h.ledger.reserve(
          { player_id: p, reserve_id: uuidv7(), amount: 5, currency: 'COIN', sandbox: true },
          key('reserve'),
        ),
      ),
    ).rejects.toMatchObject({ code: 'insufficient_funds' });
    expect(await h.dbWallet(t, p)).toMatchObject({ available: 10, held: 0 });
  });

  // Mutation: capture, release or refund look the wallet up by player instead of by the reserve.
  it('INV-SBX-3 capture, release and refund act on the wallet of the reserve, in both environments', async () => {
    const t = newTenant();
    const p = newPlayer();
    await h.fund(t, p, 10);
    await h.consume(spinCompletedIn(true, t, p, 10, { at: '2026-11-05T10:00:00.000Z' }));
    const id = uuidv7();
    await h.as(t, () =>
      h.ledger.reserve(
        { player_id: p, reserve_id: id, amount: 4, currency: 'COIN', sandbox: true },
        key('reserve'),
      ),
    );
    expect(await h.dbWalletIn(t, p, true)).toMatchObject({ available: 6, held: 4 });
    expect(await h.dbWallet(t, p)).toMatchObject({ available: 10, held: 0 });
    await h.as(t, () => h.ledger.capture({ reserve_id: id }, key('capture')));
    expect(await h.dbWalletIn(t, p, true)).toMatchObject({ available: 6, held: 0 });
    await h.as(t, () => h.ledger.refund({ reserve_id: id }, key('refund')));
    expect(await h.dbWalletIn(t, p, true)).toMatchObject({ available: 10, held: 0 });
    expect(await h.dbWallet(t, p)).toMatchObject({ available: 10, held: 0 });
  });
});
