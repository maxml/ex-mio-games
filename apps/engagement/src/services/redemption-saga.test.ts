import { RedemptionSagaService } from './redemption-saga.service';
import { Crash, World } from '../redemptions/testing/world';
import type { RedemptionRecord, SagaDeps, Scope } from '../redemptions/ports';

/*
 * Redemption saga, in-process against fakes: the store, the payments HTTP table (D-1, D-9), two
 * casinos behind the shared port (D-2) and a world that kills the process at named points.
 * Spec: docs/specs/engagement-store.md. Every test is named after its invariant (I-*) and its header
 * comment names the mutation that must turn it red.
 * The saga does not exist yet: every test here fails to import `./redemption-saga.service`
 * (RED for the right reason).
 *
 * Two safety nets run after EVERY test (afterEach): (1) the casino audit: the adapter may only be
 * called while the row is ISSUING with its attempt already recorded; (2) nothing else.
 */

const make = (deps: SagaDeps) => new RedemptionSagaService(deps);

type W = World<RedemptionSagaService>;

const uid = (n: number) => `0190a1b2-c3d4-7e5f-8a6b-7c8d9e0f${String(n).padStart(4, '0')}`;
const eid = (n: number) => `0190a1b2-c3d4-7e5f-8a6b-7c8d9e1f${String(n).padStart(4, '0')}`;
const P1 = uid(1);
const S1 = uid(11);
const HOUR = 3_600_000;

const worlds: W[] = [];
afterEach(() => {
  // Mutation (G1 of the review): call the adapter before the ISSUING commit -> the audit names it.
  for (const w of worlds.splice(0)) expect(w.auditViolations()).toEqual([]);
});

function setup(opts: { stock?: number | null; limit?: number | null; coins?: number } = {}) {
  const w: W = new World(make);
  worlds.push(w);
  w.payments.credit(P1, opts.coins ?? 100);
  const item = w.store.addItem({
    price: 10,
    stock: opts.stock === undefined ? 5 : opts.stock,
    perPlayerLimit: opts.limit ?? null,
  });
  return { w, item };
}

const scope = (w: W, playerId = P1, sandbox = false): Scope => ({
  tenantId: w.tenant,
  playerId,
  sandbox,
});

async function order(w: W, itemId: string, playerId = P1, key = 'k1', sandbox = false) {
  return (await w.saga.redeem(scope(w, playerId, sandbox), key, itemId)).redemption;
}

const rec = (w: W, id: string): RedemptionRecord => w.store.redemptions.get(id)!;
const state = (w: W, id: string) => rec(w, id).state;
const keys = (w: W, verb: 'reserve' | 'capture' | 'release' | 'refund') =>
  w.payments.callsOf(verb).map((c) => c.key);
const toStates = (w: W, id: string) => rec(w, id).history.map((h) => h.to);
const operator = (role: 'owner' | 'admin' | 'analyst') => ({ id: 'op-1', role });

/** Casino keeps failing with a 500: attempts run out and the redemption waits for a human. */
async function exhausted() {
  const { w, item } = setup();
  w.casino.sticky = 'error500';
  const r = await order(w, item.id);
  await w.settle(60);
  expect(state(w, r.id)).toBe('NEEDS_REVIEW');
  expect(rec(w, r.id).failureReason).toBe('attempts_exhausted');
  return { w, r, item };
}

// ---------------------------------------------------------------------------------------------
describe('I-ORDER: one order per operation key; reserve stock first, coins second', () => {
  // Mutation: drop the dedupe lookup in placeOrder -> second call creates a second order and reserve.
  it('I-ORDER-1 duplicate redemption key -> one order, one coin reserve, stock taken once', async () => {
    const { w, item } = setup();
    const a = await w.saga.redeem(scope(w), 'k1', item.id);
    const b = await w.saga.redeem(scope(w), 'k1', item.id);
    expect(b.created).toBe(false);
    expect(b.redemption.id).toBe(a.redemption.id);
    expect(keys(w, 'reserve')).toEqual([`hold:${a.redemption.id}`]);
    expect(w.payments.effects.reserve).toBe(1);
    expect(w.store.stockOf(item.id)).toBe(4);
  });

  // Mutation: the saga retries or swallows a losing order, or reserves coins before the stock is
  // taken -> more than one reserve reaches payments, or a loser's error loses its code.
  it('I-ORDER-2 concurrent redemptions for the last item -> exactly one wins, losers are out_of_stock, one reserve', async () => {
    const { w, item } = setup({ stock: 1 });
    const players = [2, 3, 4, 5, 6].map(uid);
    for (const p of players) w.payments.credit(p, 100);
    const results = await Promise.allSettled(
      players.map((p) => w.saga.redeem(scope(w, p), `k-${p}`, item.id)),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    for (const r of results.filter((x) => x.status === 'rejected') as PromiseRejectedResult[])
      expect(r.reason).toMatchObject({ code: 'out_of_stock' });
    expect(w.store.stockOf(item.id)).toBe(0);
    expect(w.payments.callsOf('reserve')).toHaveLength(1);
  });

  // Mutation: skip the per-player counter.
  it('I-ORDER-3 per-player limit refuses the third order of a limit-2 item', async () => {
    const { w, item } = setup({ limit: 2, stock: null });
    await order(w, item.id, P1, 'k1');
    await order(w, item.id, P1, 'k2');
    await expect(order(w, item.id, P1, 'k3')).rejects.toMatchObject({ code: 'limit_reached' });
  });

  // Mutation: the saga takes price or mapping from anything but the order record (for example it
  // re-reads the item) -> the reserve amount or the casino request changes.
  it('I-ORDER-4 price and reward mapping changed after the order -> reserve, capture and the casino request use the frozen values', async () => {
    const { w, item } = setup();
    const r = await order(w, item.id);
    w.store.editItem(item.id, { price: 99, reward: { type: 'cash_bonus', params: {} } });
    await w.settle();
    expect(state(w, r.id)).toBe('COMPLETED');
    expect(w.payments.reserves.get(r.id)?.amount).toBe(10);
    expect(w.payments.bal(P1).captured).toBe(10);
    expect(w.casino.issueCalls[0]?.request.reward).toEqual({
      type: 'free_spins',
      amount_minor: 10,
      currency: 'EUR',
    });
  });

  // F10. Mutation: drop the `amount === frozen price` guard, or leave the order in REQUESTED.
  it('I-ORDER-5 a reserve that answers another amount than the frozen price -> NEEDS_REVIEW with an alert, never stranded', async () => {
    const { w, item } = setup();
    const reserve = jest
      .spyOn(w.payments, 'reserve')
      .mockResolvedValueOnce({ ok: true, amount: 11 });
    const r = await order(w, item.id);
    expect(state(w, r.id)).toBe('NEEDS_REVIEW');
    expect(rec(w, r.id).failureReason).toBe('hold_amount_mismatch');
    expect(rec(w, r.id).reservation).toBe('reserved'); // the operator decides; nothing is given back silently
    expect(w.events('engagement.redemption.needs_review')).toHaveLength(1);
    expect(w.casino.issueCalls).toHaveLength(0);
    await w.settle(4);
    expect(state(w, r.id)).toBe('NEEDS_REVIEW');
    expect(reserve).toHaveBeenCalledTimes(1); // the sweeper does not send it again
  });
});

// ---------------------------------------------------------------------------------------------
describe('I-OUTCOME: success, funds failure, final rejection', () => {
  it('I-OUTCOME-1 casino accepts -> COMPLETED, one capture, one reward, balance down by the price', async () => {
    const { w, item } = setup();
    const r = await order(w, item.id);
    await w.settle();
    expect(state(w, r.id)).toBe('COMPLETED');
    expect(rec(w, r.id).reservation).toBe('committed');
    expect(w.effects).toBe(1);
    expect(w.casino.issueCalls[0]?.key).toBe(`redeem:${r.id}`);
    expect(w.payments.holdState(r.id)).toBe('captured');
    expect(w.payments.bal(P1)).toEqual({ available: 90, held: 0, captured: 10 });
    expect(keys(w, 'reserve')).toEqual([`hold:${r.id}`]);
    expect(keys(w, 'capture')).toEqual([`capture:${r.id}`]);
  });

  // D-8 / F9. Mutation: answer 202 and park the failure on GET, or do not release the stock.
  it('I-OUTCOME-2 insufficient funds -> the POST itself is refused with insufficient_funds, stock is back, the casino is never called', async () => {
    const { w, item } = setup({ coins: 0 });
    await expect(order(w, item.id)).rejects.toMatchObject({ code: 'insufficient_funds' });
    const id = [...w.store.redemptions.keys()][0]!;
    expect(state(w, id)).toBe('REJECTED_FUNDS');
    expect(rec(w, id).failureReason).toBe('insufficient_funds');
    expect(rec(w, id).reservation).toBe('released');
    expect(w.store.stockOf(item.id)).toBe(5);
    expect(w.casino.issueCalls).toHaveLength(0);
    expect(w.payments.holdState(id)).toBeUndefined();
    const rejected = w.events('engagement.redemption.rejected');
    expect(rejected.map((e) => (e.payload as { reason: string }).reason)).toEqual([
      'insufficient_funds',
    ]);
    // a replay of the same key answers the same way and does not ask payments again
    await expect(order(w, item.id)).rejects.toMatchObject({ code: 'insufficient_funds' });
    expect(w.payments.callsOf('reserve')).toHaveLength(1);
  });

  // Mutation: skip the release; or call refund instead of release.
  it('I-OUTCOME-3 casino rejects -> REJECTED then RELEASED, balance restored, stock back, no refund', async () => {
    const { w, item } = setup();
    w.casino.sticky = 'reject';
    const r = await order(w, item.id);
    await w.settle();
    expect(state(w, r.id)).toBe('RELEASED');
    expect(w.effects).toBe(0);
    expect(w.payments.bal(P1)).toEqual({ available: 100, held: 0, captured: 0 });
    expect(w.payments.callsOf('refund')).toHaveLength(0);
    expect(keys(w, 'release')).toEqual([`release:${r.id}`]);
    expect(w.store.stockOf(item.id)).toBe(5);
    expect(toStates(w, r.id)).toEqual(['REQUESTED', 'RESERVED', 'ISSUING', 'REJECTED', 'RELEASED']);
  });

  // Mutation: set RELEASED when the release is requested instead of when payments answered.
  it('I-OUTCOME-4 RELEASED only after payments answered; a release that cannot be delivered is retried with the same key', async () => {
    const { w, item } = setup();
    w.casino.sticky = 'reject';
    const r = await order(w, item.id);
    await w.settle(1); // rejected by the casino, release not yet sent
    expect(state(w, r.id)).toBe('REJECTED');
    w.payments.down = true;
    await w.settle(6);
    expect(state(w, r.id)).toBe('REJECTED');
    expect(w.payments.effects.release).toBe(0);
    w.payments.down = false;
    await w.settle();
    expect(state(w, r.id)).toBe('RELEASED');
    expect(w.payments.effects.release).toBe(1);
    expect(new Set(keys(w, 'release'))).toEqual(new Set([`release:${r.id}`]));
    expect(w.payments.bal(P1).available).toBe(100);
  });
});

// ---------------------------------------------------------------------------------------------
describe('I-RESERVE: the coin reserve is a synchronous call with a durable retry', () => {
  // Mutation: do not retry a REQUESTED order, or retry with a fresh key.
  it('I-RESERVE-1 payments unreachable during the POST -> the order is accepted as REQUESTED and the sweeper reserves later with the same key', async () => {
    const { w, item } = setup();
    w.payments.down = true;
    const r = await order(w, item.id); // no error for the player: the answer is "pending"
    expect(state(w, r.id)).toBe('REQUESTED');
    expect(w.store.stockOf(item.id)).toBe(4);
    await w.settle(3);
    expect(state(w, r.id)).toBe('REQUESTED');
    w.payments.down = false;
    await w.settle();
    expect(state(w, r.id)).toBe('COMPLETED');
    expect(w.payments.effects.reserve).toBe(1);
    expect(new Set(keys(w, 'reserve'))).toEqual(new Set([`hold:${r.id}`]));
  });

  // Mutation: map every refusal to insufficient_funds, or release the reservation on an unclear refusal.
  it('I-RESERVE-2 a refusal other than insufficient_funds -> NEEDS_REVIEW reserve_refused, nothing released', async () => {
    const { w, item } = setup();
    jest
      .spyOn(w.payments, 'reserve')
      .mockResolvedValueOnce({ ok: false, code: 'operation_conflict' });
    const r = await order(w, item.id);
    expect(state(w, r.id)).toBe('NEEDS_REVIEW');
    expect(rec(w, r.id).failureReason).toBe('reserve_refused');
    expect(rec(w, r.id).reservation).toBe('reserved');
    expect(w.payments.callsOf('release')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------------------------
describe('I-AMBIGUOUS: a timeout is not a failure; recovery asks the casino by OUR key', () => {
  // Mutation: treat a timeout as a final rejection (release on timeout), or re-issue without a lookup.
  it('I-AMBIGUOUS-1 timeout after the casino issued -> UNKNOWN with coins held, then COMPLETED with one reward and one issue call', async () => {
    const { w, item } = setup();
    w.casino.plan = ['timeout_effect'];
    const r = await order(w, item.id);
    await w.settle(1);
    expect(state(w, r.id)).toBe('UNKNOWN');
    expect(w.payments.bal(P1)).toEqual({ available: 90, held: 10, captured: 0 });
    expect(w.payments.callsOf('release')).toHaveLength(0);
    expect(w.payments.callsOf('capture')).toHaveLength(0);
    await w.settle();
    expect(state(w, r.id)).toBe('COMPLETED');
    expect(w.effects).toBe(1);
    expect(w.casino.issueCalls).toHaveLength(1); // recovered by lookup, not re-issued
    expect(w.casino.statusCalls[0]?.key).toBe(`redeem:${r.id}`);
    expect(w.payments.effects.capture).toBe(1);
  });

  // Mutation: send a NEW key on a retry.
  it('I-AMBIGUOUS-2 timeout with nothing issued -> lookup says not_found, retry with the SAME key, one reward', async () => {
    const { w, item } = setup();
    w.casino.plan = ['timeout_noeffect'];
    const r = await order(w, item.id);
    await w.settle();
    expect(state(w, r.id)).toBe('COMPLETED');
    expect(w.casino.issueCalls).toHaveLength(2);
    expect(new Set(w.casino.issueCalls.map((c) => c.key))).toEqual(new Set([`redeem:${r.id}`]));
    expect(w.effects).toBe(1);
    expect(w.payments.callsOf('release')).toHaveLength(0);
  });

  it('I-AMBIGUOUS-3 two 500s then success -> COMPLETED after three attempts', async () => {
    const { w, item } = setup();
    w.casino.plan = ['error500', 'error500'];
    const r = await order(w, item.id);
    await w.settle();
    expect(state(w, r.id)).toBe('COMPLETED');
    expect(rec(w, r.id).attempts).toBe(3);
    expect(w.casino.issueCalls).toHaveLength(3);
    expect(w.effects).toBe(1);
  });

  // Mutation: map an adapter `unknown` (unlisted rejection code) to REJECTED.
  it('I-AMBIGUOUS-4 an unknown rejection code is retryable, never final', async () => {
    const { w, item } = setup();
    w.casino.plan = ['unknown_code'];
    const r = await order(w, item.id);
    await w.settle(1);
    expect(state(w, r.id)).toBe('UNKNOWN');
    expect(w.payments.callsOf('release')).toHaveLength(0);
  });

  // Mutation: raise or remove the attempt cap; auto-release on exhaustion.
  it('I-AMBIGUOUS-5 attempts exhausted -> NEEDS_REVIEW, coins stay held, alert raised; replay ends COMPLETED', async () => {
    const { w, r } = await exhausted();
    expect(rec(w, r.id).attempts).toBe(8);
    expect(w.payments.bal(P1)).toEqual({ available: 90, held: 10, captured: 0 });
    expect(w.payments.callsOf('release')).toHaveLength(0);
    expect(w.events('engagement.redemption.needs_review')).toHaveLength(1);
    w.casino.sticky = 'ok';
    await w.saga.replay(w.tenant, r.id);
    await w.settle();
    expect(state(w, r.id)).toBe('COMPLETED');
    expect(w.effects).toBe(1);
  });

  // Mutation: drop the max-age check (the status endpoint stays unknown forever).
  it('I-AMBIGUOUS-6 still unknown after 24 hours -> NEEDS_REVIEW with coins held', async () => {
    const { w, item } = setup();
    w.casino.plan = ['timeout_noeffect'];
    w.casino.statusTimeout = true;
    const r = await order(w, item.id);
    await w.settle(8, 5 * HOUR);
    expect(state(w, r.id)).toBe('NEEDS_REVIEW');
    expect(rec(w, r.id).failureReason).toBe('unknown_too_long');
    expect(rec(w, r.id).attempts).toBe(1);
    expect(w.payments.bal(P1).held).toBe(10);
    expect(w.payments.callsOf('release')).toHaveLength(0);
  });

  // Mutation: keep the retry schedule in an in-memory timer.
  it('I-AMBIGUOUS-7 restart during backoff -> the sweeper resumes from durable state, one reward', async () => {
    const { w, item } = setup();
    w.casino.plan = ['timeout_noeffect'];
    const r = await order(w, item.id);
    await w.settle(1);
    expect(state(w, r.id)).toBe('UNKNOWN');
    w.restart();
    await w.settle();
    expect(state(w, r.id)).toBe('COMPLETED');
    expect(w.effects).toBe(1);
  });
});

// ---------------------------------------------------------------------------------------------
describe('I-PENDING: a casino that answers "pending" (a ticket) is waiting, not failing (D-2)', () => {
  // Mutation: count `pending` as a failed attempt, release on it, or capture on it.
  it('I-PENDING-1 issue answers pending{external_ref} -> UNKNOWN with the ref stored, coins held, no attempt consumed; a later issued -> COMPLETED with one effect', async () => {
    const { w, item } = setup();
    w.casino.sticky = 'pending_then_issued';
    const r = await order(w, item.id);
    await w.settle(4);
    expect(state(w, r.id)).toBe('UNKNOWN');
    expect(rec(w, r.id).casinoReference).toBe('ticket-1');
    expect(rec(w, r.id).attempts).toBe(1); // the one attempt of the first call; polling adds none
    expect(w.casino.issueCalls).toHaveLength(1);
    expect(w.casino.statusCalls.length).toBeGreaterThan(0);
    expect(w.payments.callsOf('capture')).toHaveLength(0);
    expect(w.payments.callsOf('release')).toHaveLength(0);
    expect(w.payments.bal(P1)).toEqual({ available: 90, held: 10, captured: 0 });
    w.casino.settle(`redeem:${r.id}`, 'issued');
    await w.settle();
    expect(state(w, r.id)).toBe('COMPLETED');
    expect(w.effects).toBe(1);
    expect(w.casino.issueCalls).toHaveLength(1);
    expect(rec(w, r.id).casinoReference).toBe('ticket-1');
  });

  // Mutation: let a pending lookup fall through to "retry" (a second issue), or never age out.
  it('I-PENDING-2 the lookup keeps answering pending -> never re-issued, never released; NEEDS_REVIEW only past 24 h, coins held', async () => {
    const { w, item } = setup();
    w.casino.sticky = 'pending_forever';
    const r = await order(w, item.id);
    await w.settle(10);
    expect(state(w, r.id)).toBe('UNKNOWN');
    w.clock.advance(25 * HOUR);
    await w.settle(2);
    expect(state(w, r.id)).toBe('NEEDS_REVIEW');
    expect(rec(w, r.id).failureReason).toBe('unknown_too_long');
    expect(toStates(w, r.id).filter((s) => s === 'ISSUING')).toHaveLength(1);
    expect(rec(w, r.id).attempts).toBe(1);
    expect(w.casino.issueCalls).toHaveLength(1);
    expect(w.payments.callsOf('release')).toHaveLength(0);
    expect(w.payments.bal(P1).held).toBe(10);
  });

  // Mutation: ignore a rejected ticket, or release twice.
  it('I-PENDING-3 pending then rejected -> REJECTED, then RELEASED, one release, one issue call', async () => {
    const { w, item } = setup();
    w.casino.sticky = 'pending_then_rejected';
    const r = await order(w, item.id);
    await w.settle(2);
    expect(state(w, r.id)).toBe('UNKNOWN');
    w.casino.settle(`redeem:${r.id}`, 'rejected');
    await w.settle();
    expect(state(w, r.id)).toBe('RELEASED');
    expect(toStates(w, r.id)).toContain('REJECTED');
    expect(w.payments.effects.release).toBe(1);
    expect(w.casino.issueCalls).toHaveLength(1);
    expect(w.effects).toBe(0);
  });

  // F2. Casino B has no lookup by key: the frozen request is passed again. Mutation: call
  // `getRewardStatus` without the request, or with a request rebuilt from the live catalog.
  it('I-PENDING-4 casino B drops the reply -> recovered by replaying the FROZEN request: one effect, the same ticket', async () => {
    const { w, item } = setup();
    w.casino.lookup = 'replay';
    w.casino.plan = ['drop_reply'];
    const r = await order(w, item.id);
    w.store.editItem(item.id, { reward: { type: 'cash_bonus', params: {} } }); // the live catalog moves on
    await w.settle(2);
    expect(state(w, r.id)).toBe('UNKNOWN');
    w.casino.settle(`redeem:${r.id}`, 'issued');
    await w.settle();
    expect(state(w, r.id)).toBe('COMPLETED');
    expect(w.casino.issueCalls).toHaveLength(1);
    expect(w.effects).toBe(1);
    const first = w.casino.issueCalls[0]!.request;
    expect(first.external_player_id).toBe(`ext-${P1}`);
    expect(first.reward.type).toBe('free_spins');
    expect(w.casino.statusCalls.length).toBeGreaterThan(0);
    for (const c of w.casino.statusCalls) expect(c.request).toEqual(first);
  });
});

// ---------------------------------------------------------------------------------------------
describe('I-RELEASE-GATE: coins go back only after `rejected` (D-2); never after `unknown`', () => {
  // Mutation: release on a status timeout or on exhaustion. The gate is the single saga function
  // that calls payments release.
  it('I-RELEASE-GATE-1 issue unknown and every lookup unknown (status timeout) until exhaustion and past 24 h -> zero release calls, NEEDS_REVIEW', async () => {
    const { w, item } = setup();
    w.casino.sticky = 'error500';
    w.casino.statusTimeout = true;
    const r = await order(w, item.id);
    await w.settle(10, 5 * HOUR);
    expect(state(w, r.id)).toBe('NEEDS_REVIEW');
    expect(w.payments.callsOf('release')).toHaveLength(0);
    expect(w.payments.callsOf('refund')).toHaveLength(0);
    expect(w.payments.bal(P1).held).toBe(10);
  });

  // Mutation: release on an early not_found.
  it('I-RELEASE-GATE-2 not_found before the deadline -> a retry with the same key, never a release', async () => {
    const { w, item } = setup();
    w.casino.plan = ['timeout_noeffect', 'timeout_noeffect'];
    const r = await order(w, item.id);
    await w.settle(3);
    expect(w.casino.issueCalls.length).toBeGreaterThanOrEqual(2);
    expect(new Set(w.casino.issueCalls.map((c) => c.key))).toEqual(new Set([`redeem:${r.id}`]));
    expect(w.payments.callsOf('release')).toHaveLength(0);
    await w.settle();
    expect(state(w, r.id)).toBe('COMPLETED');
  });

  // The automatic path is stricter than D-2 allows: not_found never releases, not even at exhaustion.
  // Mutation: release when the attempts run out on not_found.
  it('I-RELEASE-GATE-3 not_found on every lookup until attempts run out -> NEEDS_REVIEW, no release by the sweeper', async () => {
    const { w } = await exhausted();
    expect(w.casino.statusCalls.length).toBeGreaterThan(0);
    expect(w.payments.callsOf('release')).toHaveLength(0);
    expect(w.payments.bal(P1).held).toBe(10);
  });

  // Mutation: operator not_issued releases on the operator's word, without a fresh lookup.
  it('I-RELEASE-GATE-4 operator not_issued needs a fresh lookup: unknown, or not_found before the deadline, or issued -> release_not_allowed, nothing released', async () => {
    const { w, r } = await exhausted();
    const lookups = () => w.casino.statusCalls.length;
    const input = {
      outcome: 'not_issued' as const,
      reason: 'casino says no',
      operator: operator('admin'),
    };

    // (b) not_found, but the issue deadline (first attempt + 24 h) has not passed
    const before = lookups();
    await expect(w.saga.resolveReview(w.tenant, r.id, input)).rejects.toMatchObject({
      code: 'release_not_allowed',
    });
    expect(lookups()).toBe(before + 1); // a fresh lookup was made
    // (a) past the deadline, but the lookup itself times out
    w.clock.advance(25 * HOUR);
    w.casino.statusTimeout = true;
    await expect(w.saga.resolveReview(w.tenant, r.id, input)).rejects.toMatchObject({
      code: 'release_not_allowed',
    });
    // (c) past the deadline and the casino says it DID issue
    w.casino.statusTimeout = false;
    w.casino.tickets.set(`redeem:${r.id}`, {
      ref: 'late',
      status: 'issued',
      request: w.casino.issueCalls[0]!.request,
    });
    await expect(w.saga.resolveReview(w.tenant, r.id, input)).rejects.toMatchObject({
      code: 'release_not_allowed',
    });
    expect(state(w, r.id)).toBe('NEEDS_REVIEW');
    await w.settle(3);
    expect(w.payments.callsOf('release')).toHaveLength(0);

    // the only non-`rejected` way out: not_found from a lookup made AFTER the deadline
    w.casino.tickets.delete(`redeem:${r.id}`);
    await w.saga.resolveReview(w.tenant, r.id, input);
    await w.settle();
    expect(state(w, r.id)).toBe('RELEASED');
    expect(w.payments.effects.release).toBe(1);
  });
});

// ---------------------------------------------------------------------------------------------
describe('I-DEDUPE and I-LATE: duplicate and late news', () => {
  // Mutation: let two sweepers both pass the RESERVED -> ISSUING check, or call the adapter
  // without winning the transition.
  it('I-DEDUPE-1 two sweepers running at once -> one issue call, one effect, one capture, each state entered once', async () => {
    const { w, item } = setup();
    const r = await order(w, item.id);
    for (let i = 0; i < 6; i++) {
      await Promise.all([w.saga.sweep(w.clock.now()), w.saga.sweep(w.clock.now())]);
      w.clock.advance(6 * 60_000);
    }
    expect(state(w, r.id)).toBe('COMPLETED');
    expect(w.casino.issueCalls).toHaveLength(1);
    expect(w.effects).toBe(1);
    expect(w.payments.effects.capture).toBe(1);
    expect(toStates(w, r.id)).toEqual(['REQUESTED', 'RESERVED', 'ISSUING', 'ISSUED', 'COMPLETED']);
  });

  // Mutation: let ISSUED -> ISSUED re-capture on a repeated report.
  it('I-DEDUPE-2 the success report sent twice (same and different delivery id) after UNKNOWN -> ISSUED once, one capture', async () => {
    const { w, item } = setup();
    w.casino.plan = ['timeout_noeffect'];
    const r = await order(w, item.id);
    await w.settle(1);
    expect(state(w, r.id)).toBe('UNKNOWN');
    const report = { outcome: 'issued', external_ref: 'late-1' } as const;
    await w.saga.onCasinoReport(w.tenant, r.id, report, eid(1));
    await w.saga.onCasinoReport(w.tenant, r.id, report, eid(1));
    await w.saga.onCasinoReport(w.tenant, r.id, report, eid(2));
    await w.settle();
    expect(state(w, r.id)).toBe('COMPLETED');
    expect(rec(w, r.id).casinoReference).toBe('late-1');
    expect(w.payments.callsOf('capture')).toHaveLength(1);
    expect(w.payments.effects.capture).toBe(1);
    expect(w.casino.issueCalls).toHaveLength(1);
  });

  // F5. The state guard cannot stop this one: after the operator resolved the review, COMPLETED ->
  // NEEDS_REVIEW is legal again, so only the inbox row of the old delivery stops a redelivery.
  // Mutation: remove `dedupe` from the report handler's `apply`.
  it('I-DEDUPE-3 an old report redelivered after the operator resolved its review -> no second review', async () => {
    const { w, item } = setup();
    const r = await order(w, item.id);
    await w.settle();
    const late = { outcome: 'rejected', reason: 'revoked_by_risk' } as const;
    await w.saga.onCasinoReport(w.tenant, r.id, late, eid(7));
    expect(state(w, r.id)).toBe('NEEDS_REVIEW');
    await w.saga.resolveReview(w.tenant, r.id, {
      outcome: 'issued',
      reason: 'risk team confirmed the reward stands',
      operator: operator('admin'),
    });
    await w.settle();
    expect(state(w, r.id)).toBe('COMPLETED');
    const historyLength = rec(w, r.id).history.length;
    await w.saga.onCasinoReport(w.tenant, r.id, late, eid(7));
    expect(state(w, r.id)).toBe('COMPLETED');
    expect(rec(w, r.id).history).toHaveLength(historyLength);
    expect(w.events('engagement.redemption.needs_review')).toHaveLength(1);
  });

  // Mutation: let a late success after RELEASED move coins (capture or re-issue).
  it('I-LATE-1 late success after RELEASED -> NEEDS_REVIEW, alert, no coin movement, reader sees the reason', async () => {
    const { w, item } = setup();
    w.casino.sticky = 'reject';
    const r = await order(w, item.id);
    await w.settle();
    expect(state(w, r.id)).toBe('RELEASED');
    await w.saga.onCasinoReport(
      w.tenant,
      r.id,
      { outcome: 'issued', external_ref: 'ghost' },
      eid(1),
    );
    await w.settle();
    expect(state(w, r.id)).toBe('NEEDS_REVIEW');
    expect(w.payments.callsOf('capture')).toHaveLength(0);
    expect(w.payments.callsOf('refund')).toHaveLength(0);
    expect(w.payments.bal(P1)).toEqual({ available: 100, held: 0, captured: 0 });
    expect(w.events('engagement.redemption.needs_review')).toHaveLength(1);
    const listed = await w.store.listForOperator(w.tenant, 'NEEDS_REVIEW');
    expect(listed.map((x) => [x.id, x.failureReason])).toEqual([
      [r.id, 'late_success_after_release'],
    ]);
  });

  // Mutation: let a late rejection after COMPLETED release or refund coins.
  it('I-LATE-2 late rejection after COMPLETED -> NEEDS_REVIEW, no coin movement', async () => {
    const { w, item } = setup();
    const r = await order(w, item.id);
    await w.settle();
    await w.saga.onCasinoReport(
      w.tenant,
      r.id,
      { outcome: 'rejected', reason: 'revoked_by_risk' },
      eid(1),
    );
    await w.settle();
    expect(state(w, r.id)).toBe('NEEDS_REVIEW');
    expect(rec(w, r.id).failureReason).toBe('late_rejection_after_complete');
    expect(w.payments.callsOf('release')).toHaveLength(0);
    expect(w.payments.bal(P1)).toEqual({ available: 90, held: 0, captured: 10 });
  });

  // Mutation: ignore a refused capture. Payments does not say WHY (D-9), so the reason is ours.
  it.each(['invalid_reserve_transition', 'reserve_not_found'] as const)(
    'I-LATE-3 a capture refused with %s -> NEEDS_REVIEW capture_refused, ledger conserved',
    async (code) => {
      const { w, item } = setup();
      const r = await order(w, item.id);
      await w.settle(1);
      expect(state(w, r.id)).toBe('ISSUED');
      jest.spyOn(w.payments, 'capture').mockResolvedValueOnce({ ok: false, code });
      await w.settle(1);
      expect(state(w, r.id)).toBe('NEEDS_REVIEW');
      expect(rec(w, r.id).failureReason).toBe('capture_refused');
      expect(w.payments.total(P1)).toBe(100);
    },
  );

  it('I-LATE-4 a release refused by payments -> NEEDS_REVIEW release_refused', async () => {
    const { w, item } = setup();
    w.casino.sticky = 'reject';
    const r = await order(w, item.id);
    await w.settle(1);
    expect(state(w, r.id)).toBe('REJECTED');
    jest
      .spyOn(w.payments, 'release')
      .mockResolvedValueOnce({ ok: false, code: 'invalid_reserve_transition' });
    await w.settle(1);
    expect(state(w, r.id)).toBe('NEEDS_REVIEW');
    expect(rec(w, r.id).failureReason).toBe('release_refused');
  });
});

// ---------------------------------------------------------------------------------------------
describe('I-STOCK and I-REPLAY: money paths through the review (D-8)', () => {
  // P4 of the review. Mutation: let the second release restore stock again (a release not
  // conditional on the reservation) -> stock 6 from 5.
  it('I-STOCK-1 RELEASED -> late success -> review -> operator not_issued -> release again: stock is back exactly once', async () => {
    const { w, item } = setup();
    w.casino.sticky = 'reject';
    const r = await order(w, item.id);
    await w.settle();
    expect(state(w, r.id)).toBe('RELEASED');
    expect(w.store.stockOf(item.id)).toBe(5);
    await w.saga.onCasinoReport(
      w.tenant,
      r.id,
      { outcome: 'issued', external_ref: 'ghost' },
      eid(1),
    );
    expect(state(w, r.id)).toBe('NEEDS_REVIEW');
    // the casino's own lookup says `rejected`, so the operator's word is backed
    await w.saga.resolveReview(w.tenant, r.id, {
      outcome: 'not_issued',
      reason: 'the ghost was a duplicate callback',
      operator: operator('owner'),
    });
    await w.settle();
    expect(state(w, r.id)).toBe('RELEASED');
    expect(w.store.stockOf(item.id)).toBe(5);
    expect(w.payments.effects.release).toBe(1);
    expect(w.payments.bal(P1)).toEqual({ available: 100, held: 0, captured: 0 });
  });

  // P5 of the review. Mutation: drop the replay guard (in `apply`) -> a second reward is issued
  // after the coins went back.
  it('I-REPLAY-1 replay of a review entered after RELEASED is refused: the casino is never asked again', async () => {
    const { w, item } = setup();
    w.casino.sticky = 'reject';
    const r = await order(w, item.id);
    await w.settle();
    await w.saga.onCasinoReport(
      w.tenant,
      r.id,
      { outcome: 'issued', external_ref: 'ghost' },
      eid(1),
    );
    expect(state(w, r.id)).toBe('NEEDS_REVIEW');
    const calls = w.casino.issueCalls.length;
    w.casino.sticky = 'ok';
    await expect(w.saga.replay(w.tenant, r.id)).rejects.toMatchObject({
      code: 'illegal_transition',
    });
    await w.settle(4);
    expect(state(w, r.id)).toBe('NEEDS_REVIEW');
    expect(w.casino.issueCalls).toHaveLength(calls);
    expect(w.effects).toBe(0);
  });

  it('I-REPLAY-2 replay of a review entered from COMPLETED is refused', async () => {
    const { w, item } = setup();
    const r = await order(w, item.id);
    await w.settle();
    await w.saga.onCasinoReport(w.tenant, r.id, { outcome: 'rejected', reason: 'risk' }, eid(1));
    expect(state(w, r.id)).toBe('NEEDS_REVIEW');
    await expect(w.saga.replay(w.tenant, r.id)).rejects.toMatchObject({
      code: 'illegal_transition',
    });
    expect(w.casino.issueCalls).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------------------------
describe('I-REFUND and I-REVIEW: compensation of a captured spend, operator resolution', () => {
  // Mutation: drop the state guard so a second revocation sends a second refund.
  it('I-REFUND-1 revoked reward -> REFUNDED, exactly one refund even with repeated and parallel reports', async () => {
    const { w, item } = setup();
    const r = await order(w, item.id);
    await w.settle();
    await Promise.all([
      w.saga.onCasinoReport(w.tenant, r.id, { outcome: 'revoked' }, eid(1)),
      w.saga.onCasinoReport(w.tenant, r.id, { outcome: 'revoked' }, eid(2)),
    ]);
    await w.saga.onCasinoReport(w.tenant, r.id, { outcome: 'revoked' }, eid(3));
    await w.settle();
    expect(state(w, r.id)).toBe('REFUNDED');
    // parallel reports may both reach payments; its by-state idempotency makes that one effect
    expect(new Set(keys(w, 'refund'))).toEqual(new Set([`refund:${r.id}`]));
    expect(w.payments.effects.refund).toBe(1);
    expect(w.payments.bal(P1)).toEqual({ available: 100, held: 0, captured: 0 });
  });

  it('I-REFUND-2 a refund refused by payments -> NEEDS_REVIEW refund_refused, no coin movement', async () => {
    const { w, item } = setup();
    const r = await order(w, item.id);
    await w.settle();
    jest
      .spyOn(w.payments, 'refund')
      .mockResolvedValueOnce({ ok: false, code: 'invalid_reserve_transition' });
    await w.saga.onCasinoReport(w.tenant, r.id, { outcome: 'revoked' }, eid(1));
    expect(state(w, r.id)).toBe('NEEDS_REVIEW');
    expect(rec(w, r.id).failureReason).toBe('refund_refused');
    expect(w.payments.bal(P1)).toEqual({ available: 90, held: 0, captured: 10 });
  });

  // Mutation: remove the role check in resolveReview.
  it('I-REVIEW-1 only owner/admin resolve; an analyst is forbidden and nothing changes', async () => {
    const { w, r } = await exhausted();
    await expect(
      w.saga.resolveReview(w.tenant, r.id, {
        outcome: 'issued',
        reason: 'looks fine to me',
        operator: operator('analyst'),
      }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    expect(state(w, r.id)).toBe('NEEDS_REVIEW');
  });

  it('I-REVIEW-2 operator resolves issued -> capture follows; not_issued (casino confirms, past the deadline) -> release follows; the reason is audited', async () => {
    // D-18: `issued` needs a lookup that says `issued`. The casino did issue, the reply was lost,
    // every lookup timed out until the row went to review; now the lookup answers `issued`.
    const { w: aw, item: aitem } = setup();
    aw.casino.sticky = 'timeout_effect';
    aw.casino.statusTimeout = true;
    const ar = await order(aw, aitem.id);
    await aw.settle(10, 5 * HOUR);
    expect(state(aw, ar.id)).toBe('NEEDS_REVIEW');
    aw.casino.statusTimeout = false;
    const a = { w: aw, r: ar };
    await a.w.saga.resolveReview(a.w.tenant, a.r.id, {
      outcome: 'issued',
      reason: 'verified in casino back office',
      operator: { id: 'op-1', role: 'admin' },
    });
    await a.w.settle();
    expect(state(a.w, a.r.id)).toBe('COMPLETED');
    expect(a.w.payments.effects.capture).toBe(1);
    expect(
      rec(a.w, a.r.id).history.some((h) => h.cause.includes('verified in casino back office')),
    ).toBe(true);
    const b = await exhausted();
    b.w.clock.advance(25 * HOUR); // the issue deadline has passed; the lookup answers not_found
    await b.w.saga.resolveReview(b.w.tenant, b.r.id, {
      outcome: 'not_issued',
      reason: 'casino confirms no reward',
      operator: { id: 'op-1', role: 'owner' },
    });
    await b.w.settle();
    expect(state(b.w, b.r.id)).toBe('RELEASED');
    expect(b.w.payments.bal(P1).available).toBe(100);
    expect(
      rec(b.w, b.r.id).history.some((h) => h.cause.includes('casino confirms no reward')),
    ).toBe(true);
  });

  // Mutation: let `issued` resolve a review that was never sent to the casino.
  it('I-REVIEW-3 a review entered from REQUESTED: `issued` is refused (the casino was never asked); `not_issued` releases without a lookup', async () => {
    const { w, item } = setup();
    jest
      .spyOn(w.payments, 'reserve')
      .mockResolvedValueOnce({ ok: false, code: 'operation_conflict' });
    const r = await order(w, item.id);
    expect(state(w, r.id)).toBe('NEEDS_REVIEW');
    await expect(
      w.saga.resolveReview(w.tenant, r.id, {
        outcome: 'issued',
        reason: 'I think so',
        operator: operator('admin'),
      }),
    ).rejects.toMatchObject({ code: 'illegal_transition' });
    // payments really holds the coins in this scenario: let the fake hold them for the release
    await w.payments.reserve(
      { tenantId: w.tenant, playerId: P1, sandbox: false, reserveId: r.id, amount: 10 },
      `hold:${r.id}`,
    );
    await w.saga.resolveReview(w.tenant, r.id, {
      outcome: 'not_issued',
      reason: 'reserve answer unclear, giving back',
      operator: operator('admin'),
    });
    await w.settle();
    expect(state(w, r.id)).toBe('RELEASED');
    expect(w.casino.issueCalls).toHaveLength(0);
    expect(w.casino.statusCalls).toHaveLength(0);
    expect(w.store.stockOf(item.id)).toBe(5);
    expect(w.payments.bal(P1)).toEqual({ available: 100, held: 0, captured: 0 });
  });
});

// ---------------------------------------------------------------------------------------------
describe('I-CRASH: killed at each durable boundary, the run ends as the no-crash run', () => {
  // [boundary number in MIO-066, kill point owned by the world, outcome]. The kill is placed by the
  // world on the ports the saga calls; the saga has no hook and cannot choose where it dies.
  const cases: [number, string, 'ok' | 'reject'][] = [
    [1, 'after_place', 'ok'], // the order committed, the coin reserve was never sent
    [2, 'payments:after_effect:reserve', 'ok'], // payments reserved, the reply was lost
    [3, 'after_commit:ISSUING', 'ok'], // ISSUING committed, the adapter was not yet called
    [4, 'casino:after_effect', 'ok'], // the casino issued, the reply was lost
    [5, 'after_commit:ISSUED', 'ok'], // ISSUED committed, the capture was not yet sent
    [6, 'payments:after_effect:capture', 'ok'], // payments captured, the reply was lost
    [7, 'after_commit:REJECTED', 'reject'], // REJECTED committed, the release was not yet sent
    [8, 'payments:after_effect:release', 'reject'], // payments released, the reply was lost
  ];

  async function run(kill: string | null, outcome: 'ok' | 'reject') {
    const { w, item } = setup();
    w.casino.sticky = outcome;
    if (kill) w.killOnce(kill);
    try {
      await order(w, item.id);
    } catch (e) {
      if (!(e instanceof Crash)) throw e;
    }
    w.recoverIfDead(); // the request died with the process, or the saga swallowed the error
    const id = [...w.store.redemptions.keys()][0]!;
    await w.settle();
    return { w, id, snap: w.snapshot(id) };
  }

  // Mutation (one per row): call the adapter before the ISSUING commit (rows 3 and 4: the audit
  // names it, and `effects` exceeds 1 on a casino that does not dedupe); write state and its next
  // call in separate steps (rows 1, 5, 7); drop the sweeper (rows 1, 3, 4, 5, 7); send a fresh key
  // on the repeat (rows 2, 6, 8: a second effect in payments).
  it.each(cases)(
    'I-CRASH-%i killed at %s -> same final state, ONE casino effect at most, ledger conserved',
    async (_n, kill, outcome) => {
      const reference = await run(null, outcome);
      const crashed = await run(kill, outcome);
      expect(crashed.w.restarts).toBe(1);
      expect(crashed.snap).toEqual(reference.snap);
      expect(crashed.snap.effects).toBe(outcome === 'ok' ? 1 : 0);
      expect(crashed.w.payments.total(P1)).toBe(100);
      expect(crashed.w.payments.effects.reserve).toBe(1);
      expect(crashed.w.payments.effects.capture).toBe(outcome === 'ok' ? 1 : 0);
      expect(crashed.w.payments.effects.release).toBe(outcome === 'ok' ? 0 : 1);
      expect(crashed.w.casino.issueCalls).toHaveLength(1); // recovery asks by key; it does not issue again
      expect(crashed.snap.state).toBe(outcome === 'ok' ? 'COMPLETED' : 'RELEASED');
    },
  );
});

// ---------------------------------------------------------------------------------------------
describe('I-SANDBOX: sandbox redemptions stay in the sandbox and out of metering', () => {
  // Mutation: choose the adapter from anything but the server-side sandbox flag of the order.
  it('I-SANDBOX-1 a sandbox order is issued only to the sandbox adapter; a production order never to it', async () => {
    const { w, item } = setup();
    w.payments.credit(S1, 100, true);
    const s = await order(w, item.id, S1, 'ks', true);
    const p = await order(w, item.id, P1, 'kp', false);
    await w.settle();
    expect(state(w, s.id)).toBe('COMPLETED');
    expect(state(w, p.id)).toBe('COMPLETED');
    expect(w.sandboxCasino.issueCalls.map((c) => c.request.external_player_id)).toEqual([
      `ext-${S1}`,
    ]);
    expect(w.casino.issueCalls.map((c) => c.request.external_player_id)).toEqual([`ext-${P1}`]);
  });

  // Mutation: stamp sandbox=false (or omit it) on any outbox message of a sandbox redemption.
  it('I-SANDBOX-2 every event of a redemption carries its sandbox flag, true only for sandbox', async () => {
    const { w, item } = setup();
    w.payments.credit(S1, 100, true);
    const s = await order(w, item.id, S1, 'ks', true);
    const p = await order(w, item.id, P1, 'kp', false);
    await w.settle();
    for (const row of w.store.outbox) {
      const pl = row.envelope.payload as { redemption_id: string; sandbox: boolean };
      expect(pl.sandbox).toBe(pl.redemption_id === s.id);
      expect([s.id, p.id]).toContain(pl.redemption_id);
    }
    expect(w.store.outbox.length).toBeGreaterThan(8);
  });

  // F11. Mutation: the coin reserve ignores the sandbox flag (balances keyed by player only).
  it('I-SANDBOX-3 the same player id in sandbox and production never shares coins', async () => {
    const { w, item } = setup(); // P1 has 100 production coins and no sandbox coins
    await expect(order(w, item.id, P1, 'ks', true)).rejects.toMatchObject({
      code: 'insufficient_funds',
    });
    expect(w.payments.bal(P1)).toEqual({ available: 100, held: 0, captured: 0 });
    expect(w.payments.callsOf('reserve').map((c) => c.sandbox)).toEqual([true]);
    w.payments.credit(S1, 100, true); // sandbox coins only
    await expect(order(w, item.id, S1, 'kp', false)).rejects.toMatchObject({
      code: 'insufficient_funds',
    });
    expect(w.payments.bal(S1, true)).toEqual({ available: 100, held: 0, captured: 0 });
  });
});
