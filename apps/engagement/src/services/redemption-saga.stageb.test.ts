import { RedemptionSagaService } from './redemption-saga.service';
import { World } from '../redemptions/testing/world';
import type { RedemptionRecord, Scope } from '../redemptions/ports';

/*
 * L4 stage B fix round: regression tests for the review findings (l4-stageB-review.md) and decision
 * D-18. The stage A files stay frozen; this file only adds. Every test is named after its finding and
 * its header comment names the mutation that turns it red. Same in-process world as
 * redemption-saga.test.ts (fakes for the store, payments and the casinos).
 *
 * NOTE for the coder: the frozen 'I-REVIEW-2' (redemption-saga.test.ts) resolves `issued` on a
 * review whose lookup answers `not_found` and expects COMPLETED. D-18 forbids exactly that. That
 * frozen test has to be amended by the owner of the stage A files, not by this round's coder.
 */

const make = (deps: ConstructorParameters<typeof RedemptionSagaService>[0]) =>
  new RedemptionSagaService(deps);
type W = World<RedemptionSagaService>;

const P1 = '0190a1b2-c3d4-7e5f-8a6b-7c8d9e0f0001';
const HOUR = 3_600_000;

const worlds: W[] = [];
afterEach(() => {
  for (const w of worlds.splice(0)) expect(w.auditViolations()).toEqual([]);
});

function setup(opts: { stock?: number | null; limit?: number | null } = {}) {
  const w: W = new World(make);
  worlds.push(w);
  w.payments.credit(P1, 100);
  const item = w.store.addItem({
    price: 10,
    stock: opts.stock === undefined ? 5 : opts.stock,
    perPlayerLimit: opts.limit ?? null,
  });
  return { w, item };
}

const scope = (w: W, sandbox = false): Scope => ({ tenantId: w.tenant, playerId: P1, sandbox });
const rec = (w: W, id: string): RedemptionRecord => w.store.redemptions.get(id)!;
const operator = { id: 'op-1', role: 'operator_admin' as const }; // identity's vocabulary (X-15)

// ---------------------------------------------------------------------------------------------
describe('F1: a refused coin reserve leaves no exit for the operator', () => {
  // Mutation: decide "the casino was never asked" from the LATEST entry into review (as 889eba7
  // does) instead of from the whole history, or treat `reserve_not_found` on release as a refusal
  // -> the row sticks in NEEDS_REVIEW (release_refused) and stock and limit slot never come back.
  it('F1 reserve refused by payments, operator resolves not_issued -> terminal state, stock and limit slot back exactly once, no casino call', async () => {
    const { w, item } = setup({ stock: 5, limit: 1 });
    // payments refuses the reserve for real: it holds nothing. The hold is NOT created by hand.
    jest
      .spyOn(w.payments, 'reserve')
      .mockResolvedValueOnce({ ok: false, code: 'operation_conflict' });
    const r = (await w.saga.redeem(scope(w), 'k1', item.id)).redemption;
    expect(rec(w, r.id).state).toBe('NEEDS_REVIEW');
    expect(w.payments.reserves.size).toBe(0);
    expect(w.store.stockOf(item.id)).toBe(4);

    await w.saga
      .resolveReview(w.tenant, r.id, { outcome: 'not_issued', reason: 'no hold exists', operator })
      .catch(() => undefined);
    await w.settle();
    // a second operator click must not return anything a second time
    await w.saga
      .resolveReview(w.tenant, r.id, { outcome: 'not_issued', reason: 'again', operator })
      .catch(() => undefined);
    await w.settle();

    const end = rec(w, r.id);
    expect(['RELEASED', 'REJECTED_FUNDS']).toContain(end.state);
    expect(end.reservation).toBe('released');
    expect(w.store.stockOf(item.id)).toBe(5); // 4 -> 5, not 4 and not 6
    expect(w.casino.issueCalls).toHaveLength(0);
    expect(w.casino.statusCalls).toHaveLength(0);
    expect(w.payments.callsOf('capture')).toHaveLength(0);
    expect(w.payments.bal(P1)).toEqual({ available: 100, held: 0, captured: 0 });
    // the player's limit slot (limit 1) is free again: the same player can order the item once more
    const again = (await w.saga.redeem(scope(w), 'k2', item.id)).redemption;
    expect(again.id).not.toBe(r.id);
    expect(w.store.stockOf(item.id)).toBe(4);
  });
});

// ---------------------------------------------------------------------------------------------
describe('D-18: an operator `issued` moves coins only after a lookup says `issued`', () => {
  /** The casino did issue, the reply was lost and every lookup timed out until the row went to review. */
  async function reviewAfterLostReply() {
    const { w, item } = setup();
    w.casino.sticky = 'timeout_effect';
    w.casino.statusTimeout = true;
    const r = (await w.saga.redeem(scope(w), 'k1', item.id)).redemption;
    await w.settle(10, 5 * HOUR);
    expect(rec(w, r.id).state).toBe('NEEDS_REVIEW');
    expect(w.payments.callsOf('capture')).toHaveLength(0);
    return { w, r };
  }
  const issuedInput = { outcome: 'issued' as const, reason: 'seen in back office', operator };

  // Mutation: capture on the operator's word without a fresh lookup (889eba7) -> no status call
  // after the resolve, or capture although the lookup said otherwise.
  it('D-18-a lookup returns issued -> a fresh lookup is made, then the row is ISSUED and the capture follows', async () => {
    const { w, r } = await reviewAfterLostReply();
    w.casino.statusTimeout = false; // the casino now answers: issued (its ticket exists)
    const lookups = w.casino.statusCalls.length;
    await w.saga.resolveReview(w.tenant, r.id, issuedInput);
    expect(w.casino.statusCalls.length).toBeGreaterThan(lookups);
    await w.settle();
    expect(rec(w, r.id).state).toBe('COMPLETED');
    expect(w.payments.effects.capture).toBe(1);
    expect(w.payments.bal(P1)).toEqual({ available: 90, held: 0, captured: 10 });
  });

  // Mutation: treat `unknown` or `pending` as enough for the operator's `issued`.
  it('D-18-b lookup returns unknown or pending -> the redemption stays in review, no capture, coins still held', async () => {
    const u = await reviewAfterLostReply(); // the status endpoint keeps timing out: unknown
    // refusing with an error or answering with the unchanged row are both fine; moving is not
    await u.w.saga.resolveReview(u.w.tenant, u.r.id, issuedInput).catch(() => undefined);
    await u.w.settle(3);
    expect(rec(u.w, u.r.id).state).toBe('NEEDS_REVIEW');
    expect(u.w.payments.callsOf('capture')).toHaveLength(0);
    expect(u.w.payments.bal(P1).held).toBe(10);

    const p = await reviewAfterLostReply();
    p.w.casino.statusTimeout = false;
    p.w.casino.tickets.set(`redeem:${p.r.id}`, {
      ref: 'ticket-p',
      status: 'pending',
      request: p.w.casino.issueCalls[0]!.request,
    });
    await p.w.saga.resolveReview(p.w.tenant, p.r.id, issuedInput).catch(() => undefined);
    await p.w.settle(3);
    expect(rec(p.w, p.r.id).state).toBe('NEEDS_REVIEW');
    expect(p.w.payments.callsOf('capture')).toHaveLength(0);
    expect(p.w.payments.bal(P1).held).toBe(10);
  });
});
