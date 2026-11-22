import { uuidv7 } from '@ex-mio/contracts';
import type { PlayerSession } from './player-session';
import { seedCoins } from './seed-coins';
import {
  armFault,
  balanceOf,
  casinoDeposit,
  compose,
  engagementOutbox,
  inboundRowsOf,
  inOrder,
  issuedFor,
  journalOf,
  mySpins,
  operatorRedemption,
  partCTenant,
  PRICE,
  redeem,
  republish,
  reserveStateOf,
  resetCasino,
  SEGMENT_COINS,
  sleep,
  spin,
  stackReady,
  transitions,
  waitForState,
  type PartCTenant,
} from './partc';
import { eventually, urls } from './env';

const DEPOSIT_CONFIRMED = 'engagement.deposit.confirmed';
const SPIN_COMPLETED = 'engagement.spin.completed';
/** States the saga stops in (NEEDS_REVIEW waits for an operator, so a test stops there too). */
const TERMINAL = ['COMPLETED', 'RELEASED', 'REFUNDED', 'REJECTED_FUNDS', 'NEEDS_REVIEW'];

/*
 * Part C on the real stack: issuance that times out, is rejected, or times out on a casino that
 * never issued. Reviewer-written (review/partc-compose); the in-memory saga tests exist, these prove
 * the same properties through identity, engagement, payments, Postgres and casino-sim.
 *
 * Product behaviour these tests assume (apps/engagement/src/services/redemption-saga.service.ts):
 *  - POST /v1/redemptions reserves the coins inline (202, state RESERVED); the sweeper (every 5 s)
 *    moves RESERVED -> ISSUING and calls the casino-a adapter with key `redeem:<order id>`;
 *  - an adapter call that outlives 5 s is `unknown`: ISSUING -> UNKNOWN (cause `casino_unknown`);
 *  - UNKNOWN asks the casino by our key (GET /casino-a/bonuses?idempotencyKey=...):
 *      `issued`    -> ISSUED (cause `lookup_issued`) -> capture -> COMPLETED;
 *      `not_found` -> the SAME key is sent again (UNKNOWN -> ISSUING, cause `retry_same_key`);
 *  - a 422 from the casino is `rejected`: -> REJECTED -> release -> RELEASED.
 *  The product never releases coins on `not_found` alone (within the issue deadline it re-sends);
 *  a release needs the casino's `rejected`. This is the SPECIFIED behaviour, which test 3 pins:
 *  docs/specs/engagement-store.md section 1 item 4 (`not_found` -> retry with the same key while
 *  attempts < 8), item 7 (release gate: `not_found` never releases on the automatic path, not even
 *  at exhaustion), the state table row `UNKNOWN -> ISSUING` on `not_found`, and D-18 (coins move
 *  only on evidence; a missing record is not evidence that nothing was issued).
 * Tests 4 and 5 add the bus side of Part C: deposit webhook -> spin credit -> spin -> coins.
 * Test 5 stops and starts the `rabbitmq` service (`docker compose stop|start`), so it runs last.
 * Coins: the payments reserve id is the order id; the journal holds one `reserve`, then one
 * `capture` or one `release` under that id. Balances are read through the operator route.
 *
 * casino-sim (`TIMEOUT_FAULT_DEFAULT_MS` 10 s > the adapter's 5 s) RECORDS a `timeout` request
 * before it stalls, so a timed-out reward is really issued. It has no "timeout and never issued"
 * fault; test 3 makes one by wiping casino-sim's records (`/__reset`) while the reply is in flight.
 * `/__reset` is global: the suite runs in band (`jest --runInBand`).
 */

let t: PartCTenant;
const SEED = 1000;

beforeAll(async () => {
  t = await partCTenant();
}, 90_000);

/** A launched casino-a player with SEED production coins. */
const fundedPlayer = async (): Promise<PlayerSession> => {
  const p = await t.tenant.player();
  await seedCoins(t.tenant.tenantId, p.userId, SEED, { operatorToken: t.operatorPayments });
  return p;
};

/** Reads the balance, waits one more sweep window, reads again: a late second move would show. */
const settledBalance = async (p: PlayerSession) => {
  const first = await balanceOf(t, p);
  await sleep(12_000); // more than two sweeper periods (5 s) plus the first retry backoff
  const second = await balanceOf(t, p);
  expect(second).toEqual(first);
  return second;
};

describe('Part C issuance failures (compose, casino-sim faults)', () => {
  // Mutation that must turn this red: in casino-a.adapter.ts `issueReward`, map a timeout
  // (`if (!res)`) to `{ kind: 'rejected', reason: 'timeout' }` -> the order is RELEASED, not
  // COMPLETED. Second mutation: in the saga's `inquire`, treat a lookup `issued` like `not_found`
  // (re-send) -> attempts becomes 2 and the history shows `UNKNOWN->ISSUING`.
  it('a timed-out issuance that the casino did make is found by lookup and ends COMPLETED with coins captured exactly once', async () => {
    const p = await fundedPlayer();
    await armFault({ kind: 'timeout', player_id: p.externalPlayerId });
    const id = await redeem(t, p);

    const done = await waitForState(t, id, ['COMPLETED', 'RELEASED', 'NEEDS_REVIEW']);
    expect(done.state).toBe('COMPLETED');
    const path = transitions(done);
    expect(
      inOrder(path, [
        'RESERVED->ISSUING',
        'ISSUING->UNKNOWN',
        'UNKNOWN->ISSUED',
        'ISSUED->COMPLETED',
      ]),
    ).toBe(true);
    expect(done.history.find((h) => h.to === 'UNKNOWN')?.cause).toBe('casino_unknown');
    expect(done.history.find((h) => h.from === 'UNKNOWN' && h.to === 'ISSUED')?.cause).toBe(
      'lookup_issued',
    );
    expect(path).not.toContain('UNKNOWN->ISSUING'); // found by lookup, never sent again
    expect(done.attempts).toBe(1);

    expect(await issuedFor(id)).toBe(1);
    expect(await settledBalance(p)).toEqual({ available: SEED - PRICE, held: 0 });
    expect(await journalOf(t.tenant.tenantId, id)).toEqual({ reserve: 1, capture: 1 });
    expect(await reserveStateOf(t.tenant.tenantId, id)).toBe('captured');
  }, 150_000);

  // Mutation that must turn this red: in the saga's `releaseCoins`, apply REJECTED -> RELEASED
  // without calling `coins.release` -> held stays PRICE and the journal has no `release`.
  // Second mutation: in casino-a.adapter.ts map a 422 to `unknown` -> the order never leaves
  // UNKNOWN/ISSUING (re-sends), never RELEASED.
  it('a rejected issuance ends RELEASED and returns the coins to the player exactly once', async () => {
    const p = await fundedPlayer();
    await armFault({ kind: 'reject', player_id: p.externalPlayerId });
    const id = await redeem(t, p);

    const done = await waitForState(t, id, ['RELEASED', 'COMPLETED', 'NEEDS_REVIEW']);
    expect(done.state).toBe('RELEASED');
    expect(
      inOrder(transitions(done), ['RESERVED->ISSUING', 'ISSUING->REJECTED', 'REJECTED->RELEASED']),
    ).toBe(true);
    expect(done.failure_reason).toMatch(/^casino_rejected:/);
    expect(done.attempts).toBe(1);

    expect(await issuedFor(id)).toBe(0);
    expect(await settledBalance(p)).toEqual({ available: SEED, held: 0 });
    expect(await journalOf(t.tenant.tenantId, id)).toEqual({ reserve: 1, release: 1 });
    expect(await reserveStateOf(t.tenant.tenantId, id)).toBe('released');
  }, 150_000);

  // Mutation that must turn this red: in the saga's `inquire`, on `not_found` apply UNKNOWN ->
  // REJECTED (release at once) instead of `retrySameKey` -> attempts stays 1 and the history has
  // no `UNKNOWN->ISSUING`. Second mutation: a timeout maps to `rejected` in the adapter (as in the
  // first test) -> no UNKNOWN in the history and attempts 1.
  it('a timed-out issuance that the casino never made is re-sent under the same key, and ends RELEASED with nothing issued and the coins back once', async () => {
    const p = await fundedPlayer();
    await armFault({ kind: 'timeout', player_id: p.externalPlayerId });
    const id = await redeem(t, p);

    // The request reached casino-sim (it records, then stalls for 10 s). Erase that record while
    // the adapter is still waiting: for engagement the casino has now never issued this key.
    await eventually(async () => ((await issuedFor(id)) === 1 ? true : undefined), 30_000);
    await resetCasino();
    // The same-key retry that follows the `not_found` lookup is refused for good.
    await armFault({ kind: 'reject', player_id: p.externalPlayerId });

    const done = await waitForState(t, id, ['RELEASED', 'COMPLETED', 'NEEDS_REVIEW']);
    expect(done.state).toBe('RELEASED');
    expect(
      inOrder(transitions(done), [
        'RESERVED->ISSUING',
        'ISSUING->UNKNOWN',
        'UNKNOWN->ISSUING',
        'ISSUING->REJECTED',
        'REJECTED->RELEASED',
      ]),
    ).toBe(true);
    expect(done.history.find((h) => h.from === 'UNKNOWN' && h.to === 'ISSUING')?.cause).toBe(
      'retry_same_key',
    );
    expect(done.attempts).toBe(2);

    expect(await issuedFor(id)).toBe(0);
    expect(await settledBalance(p)).toEqual({ available: SEED, held: 0 });
    expect(await journalOf(t.tenant.tenantId, id)).toEqual({ reserve: 1, release: 1 });
    expect(await reserveStateOf(t.tenant.tenantId, id)).toBe('released');
  }, 150_000);

  // Mutation that must turn this red: in ingestion.service.ts drop the `if (inserted)` around the
  // outbox write -> a second `engagement.deposit.confirmed` for the same casino event is in the
  // outbox (count 2). Second mutation: in pg-repositories.ts `insertIfAbsent`, drop
  // `ON CONFLICT (tenant_id, source, external_event_id) DO NOTHING` -> the unique index makes the
  // copies fail, so `delivered` is not [200, 200, 200]. Third mutation (the coin side): in
  // ledger.service.ts `creditSpin` pass `operationId: uuidv7()` instead of the spin id -> the
  // spin delivered again (below, with a fresh event id) is credited twice.
  it('a deposit webhook delivered three times grants one spin, and that spin credits its coins exactly once', async () => {
    const p = await t.tenant.player();
    const eventId = `partc-dup-${uuidv7()}`;
    await armFault({ kind: 'duplicateDelivery', player_id: p.externalPlayerId, copies: 3 });
    // Three identical signed webhooks: the fault really fired (not a single delivery).
    expect(await casinoDeposit(t, p, eventId)).toEqual([200, 200, 200]);

    expect(await inboundRowsOf(t.tenant.tenantId, eventId)).toBe(1);
    expect(
      await engagementOutbox(t.tenant.tenantId, DEPOSIT_CONFIRMED, 'external_event_id', eventId),
    ).toHaveLength(1);
    await eventually(async () => ((await mySpins(p)) === 1 ? true : undefined), 30_000);
    await sleep(5_000); // a late second grant from a second event would show here
    expect(await mySpins(p)).toBe(1);

    const first = await spin(p);
    expect(first.status).toBe(201);
    const { spin_id: spinId, reward_coins: coins } = (await first.json()) as {
      spin_id: string;
      reward_coins: number;
    };
    expect(coins).toBe(SEGMENT_COINS);
    const second = await spin(p);
    expect(second.status).toBe(409);
    expect(((await second.json()) as { code: string }).code).toBe('no_credit');

    // Payments credits the spin through the bus. Then the same spin arrives again, as a broker
    // redelivery would bring it (same event id) and as a re-emitted event would (new event id).
    await eventually(
      async () => ((await balanceOf(t, p))?.available === SEGMENT_COINS ? true : undefined),
      30_000,
    );
    const [env] = await engagementOutbox(t.tenant.tenantId, SPIN_COMPLETED, 'spin_id', spinId);
    expect(env).toBeDefined();
    await republish(env!);
    await republish({ ...env!, event_id: uuidv7() });

    expect(await settledBalance(p)).toEqual({ available: SEGMENT_COINS, held: 0 });
    expect(await journalOf(t.tenant.tenantId, spinId)).toEqual({ spin_award: 1 });
  }, 150_000);

  // Mutation that must turn this red: in service-kit messaging.ts `onLost`, drop
  // `.then(() => this.scheduleReconnect())` -> engagement never reconnects after the broker is
  // back, the second spin's `spin.completed` stays in the outbox and its coins never arrive
  // (available stays at one segment minus the price). Second mutation: in ledger.service.ts
  // `creditSpin` pass `operationId: uuidv7()` instead of the spin id -> the second spin,
  // delivered again after the restart, is credited twice (available one segment too high, two
  // `spin_award` rows). Third mutation: in the saga's `capture`, take the `catch` branch for an
  // `ok` reply too (reschedule instead of ISSUED -> COMPLETED) -> the order never reaches a
  // terminal state (waitForState names where it is stuck: ISSUED).
  it('a broker restart in the middle of a redemption: the order ends in exactly one terminal state and no coins move twice', async () => {
    const p = await t.tenant.player();
    // Two deposits, two spins: one spin before the outage, one while the broker is down.
    expect(await casinoDeposit(t, p, `partc-rmq-a-${uuidv7()}`)).toEqual([200]);
    expect(await casinoDeposit(t, p, `partc-rmq-b-${uuidv7()}`)).toEqual([200]);
    await eventually(async () => ((await mySpins(p)) === 2 ? true : undefined), 30_000);
    const first = await spin(p);
    expect(first.status).toBe(201);
    const spin1 = ((await first.json()) as { spin_id: string }).spin_id;
    await eventually(
      async () => ((await balanceOf(t, p))?.available === SEGMENT_COINS ? true : undefined),
      30_000,
    );

    // The order is in flight at the casino (request recorded, reply stalled) when the broker goes.
    await armFault({ kind: 'timeout', player_id: p.externalPlayerId });
    const id = await redeem(t, p);
    await eventually(async () => ((await issuedFor(id)) === 1 ? true : undefined), 30_000);
    expect(TERMINAL).not.toContain((await operatorRedemption(t, id)).state);

    let spin2 = '';
    try {
      await compose('stop', 'rabbitmq');
      // While the broker is down: the order is still not settled twice, and a spin is accepted
      // (its event waits in engagement's outbox). Same Idempotency-Key on every try (D-3).
      const key = `spin-rmq-${uuidv7()}`;
      spin2 = await eventually(async () => {
        const r = await spin(p, key);
        return r.status === 201 ? ((await r.json()) as { spin_id: string }).spin_id : undefined;
      }, 30_000);
    } finally {
      await compose('start', 'rabbitmq');
    }
    await stackReady();

    const done = await waitForState(t, id, TERMINAL, 120_000);
    expect(done.state).toBe('COMPLETED');
    // The second spin's coins arrive after the restart, once; then the same spin comes again.
    await eventually(
      async () =>
        (await balanceOf(t, p))?.available === 2 * SEGMENT_COINS - PRICE ? true : undefined,
      90_000,
    );
    const [env] = await engagementOutbox(t.tenant.tenantId, SPIN_COMPLETED, 'spin_id', spin2);
    expect(env).toBeDefined();
    await republish(env!);
    await republish({ ...env!, event_id: uuidv7() });

    expect(await settledBalance(p)).toEqual({ available: 2 * SEGMENT_COINS - PRICE, held: 0 });
    const after = await operatorRedemption(t, id);
    expect(after.state).toBe('COMPLETED');
    expect(after.history.filter((h) => TERMINAL.includes(h.to))).toHaveLength(1);
    expect(await issuedFor(id)).toBe(1);
    expect(await journalOf(t.tenant.tenantId, id)).toEqual({ reserve: 1, capture: 1 });
    expect(await reserveStateOf(t.tenant.tenantId, id)).toBe('captured');
    expect(await journalOf(t.tenant.tenantId, spin1)).toEqual({ spin_award: 1 });
    expect(await journalOf(t.tenant.tenantId, spin2)).toEqual({ spin_award: 1 });
  }, 360_000);
});

afterAll(async () => {
  // leave no armed fault behind for the next file
  await fetch(`${urls.casinoSim}/__reset`, { method: 'POST' }).catch(() => undefined);
});
