import type { PlayerSession } from './player-session';
import { seedCoins } from './seed-coins';
import {
  armFault,
  balanceOf,
  inOrder,
  issuedFor,
  journalOf,
  partCTenant,
  PRICE,
  redeem,
  reserveStateOf,
  resetCasino,
  sleep,
  transitions,
  waitForState,
  type PartCTenant,
} from './partc';
import { eventually, urls } from './env';

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
 *  a release needs the casino's `rejected`.
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
      inOrder(path, ['RESERVED->ISSUING', 'ISSUING->UNKNOWN', 'UNKNOWN->ISSUED', 'ISSUED->COMPLETED']),
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
    expect(inOrder(transitions(done), ['RESERVED->ISSUING', 'ISSUING->REJECTED', 'REJECTED->RELEASED'])).toBe(
      true,
    );
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
});

afterAll(async () => {
  // leave no armed fault behind for the next file
  await fetch(`${urls.casinoSim}/__reset`, { method: 'POST' }).catch(() => undefined);
});
