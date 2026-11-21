import { createEvent } from '@ex-mio/contracts';
import { RedemptionSagaService } from './redemption-saga.service';
import { World } from '../redemptions/testing/world';
import type { Scope } from '../redemptions/ports';

/*
 * Redemption saga, in-process against fakes (store, payments hold table, two casinos).
 * Spec: docs/specs/engagement-store.md. Every test is named after its invariant (I-*) and
 * its header comment names the mutation that must turn it red.
 * The saga and its collaborators do not exist yet: today every test here fails to import
 * `./redemption-saga.service` (RED for the right reason).
 */

const make = (deps: ConstructorParameters<typeof RedemptionSagaService>[0]) =>
  new RedemptionSagaService(deps);

type W = World<RedemptionSagaService>;

function setup(opts: { stock?: number | null; limit?: number | null; coins?: number } = {}) {
  const w: W = new World(make);
  w.payments.credit('p1', opts.coins ?? 100);
  const item = w.store.addItem({
    price: 10,
    stock: opts.stock === undefined ? 5 : opts.stock,
    perPlayerLimit: opts.limit ?? null,
  });
  return { w, item };
}

const scope = (w: W, playerId = 'p1', sandbox = false): Scope => ({
  tenantId: w.tenant,
  playerId,
  sandbox,
});

async function order(w: W, itemId: string, playerId = 'p1', key = 'k1', sandbox = false) {
  return (await w.saga.redeem(scope(w, playerId, sandbox), key, itemId)).redemption;
}

const rec = (w: W, id: string) => w.store.redemptions.get(id)!;
const state = (w: W, id: string) => rec(w, id).state;
const cmds = (w: W, type: string) => w.commands(type);
const opId = (e: { payload: unknown }) => (e.payload as { operation_id: string }).operation_id;

// ---------------------------------------------------------------------------------------------
describe('I-ORDER: one order per operation key; reserve stock first, coins second', () => {
  // Mutation: drop the dedupe lookup in placeOrder -> second call creates a second order and hold.
  it('I-ORDER-1 duplicate redemption key -> one order, one hold command, stock taken once', async () => {
    const { w, item } = setup();
    const a = await w.saga.redeem(scope(w), 'k1', item.id);
    const b = await w.saga.redeem(scope(w), 'k1', item.id);
    expect(b.created).toBe(false);
    expect(b.redemption.id).toBe(a.redemption.id);
    expect(cmds(w, 'engagement.hold.place')).toHaveLength(1);
    expect(w.store.stockOf(item.id)).toBe(4);
  });

  // Mutation: make the stock decrement a read-then-write instead of a conditional update.
  it('I-ORDER-2 concurrent redemptions for the last item -> exactly one wins, losers are out_of_stock', async () => {
    const { w, item } = setup({ stock: 1 });
    const results = await Promise.allSettled(
      ['a', 'b', 'c', 'd', 'e'].map((p) => w.saga.redeem(scope(w, p), `k-${p}`, item.id)),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    for (const r of results.filter((x) => x.status === 'rejected') as PromiseRejectedResult[])
      expect(r.reason).toMatchObject({ code: 'out_of_stock' });
    expect(w.store.stockOf(item.id)).toBe(0);
    expect(cmds(w, 'engagement.hold.place')).toHaveLength(1);
  });

  // Mutation: skip the per-player counter.
  it('I-ORDER-3 per-player limit refuses the third order of a limit-2 item', async () => {
    const { w, item } = setup({ limit: 2, stock: null });
    await order(w, item.id, 'p1', 'k1');
    await order(w, item.id, 'p1', 'k2');
    await expect(order(w, item.id, 'p1', 'k3')).rejects.toMatchObject({ code: 'limit_reached' });
  });

  // Mutation: read price/mapping from the live catalog when placing the hold or issuing.
  it('I-ORDER-4 price and reward mapping changed after REQUESTED -> hold, capture and issuance use the frozen values', async () => {
    const { w, item } = setup();
    const r = await order(w, item.id);
    w.store.editItem(item.id, { price: 99, reward: { type: 'cash_bonus', params: {} } });
    await w.settle();
    expect(state(w, r.id)).toBe('COMPLETED');
    expect(w.payments.holds.get(r.id)?.amount).toBe(10);
    expect(w.payments.bal('p1').captured).toBe(10);
    expect(w.casino.issueCalls[0]?.reward.type).toBe('free_spins');
  });

  // Mutation: drop the `amount === frozen price` guard on HoldPlaced.
  it('I-ORDER-5 HoldPlaced whose amount differs from the frozen price is not applied', async () => {
    const { w, item } = setup();
    const r = await order(w, item.id);
    await w.saga.handle(
      createEvent({
        type: 'payments.hold.placed',
        tenantId: w.tenant,
        payload: { redemption_id: r.id, player_id: 'p1', sandbox: false, amount: 11 },
      }),
    );
    expect(state(w, r.id)).toBe('REQUESTED');
    expect(w.casino.issueCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------------------------
describe('I-OUTCOME: success, funds failure, final rejection', () => {
  it('I-OUTCOME-1 casino accepts -> COMPLETED, one hold CAPTURED, one reward, balance down by the price', async () => {
    const { w, item } = setup();
    const r = await order(w, item.id);
    await w.settle();
    expect(state(w, r.id)).toBe('COMPLETED');
    expect(rec(w, r.id).reservation).toBe('committed');
    expect(w.casino.rewardCount).toBe(1);
    expect(w.casino.issueCalls[0]?.idempotencyKey).toBe(`redeem:${r.id}`);
    expect(w.payments.holds.get(r.id)?.state).toBe('CAPTURED');
    expect(w.payments.bal('p1')).toEqual({ available: 90, held: 0, captured: 10 });
    expect(cmds(w, 'engagement.hold.capture').map(opId)).toEqual([`capture:${r.id}`]);
  });

  // Mutation: do not release the stock reservation on HoldRejected.
  it('I-OUTCOME-2 payment reserve failure releases the stock and never calls the casino', async () => {
    const { w, item } = setup({ coins: 0 });
    const r = await order(w, item.id);
    expect(w.store.stockOf(item.id)).toBe(4);
    await w.settle();
    expect(state(w, r.id)).toBe('REJECTED_FUNDS');
    expect(rec(w, r.id).failureReason).toBe('insufficient_funds');
    expect(rec(w, r.id).reservation).toBe('released');
    expect(w.store.stockOf(item.id)).toBe(5);
    expect(w.casino.issueCalls).toHaveLength(0);
    expect(w.payments.holds.size).toBe(0);
  });

  // Mutation: skip the ReleaseHold step; or emit RefundCapture instead of ReleaseHold.
  it('I-OUTCOME-3 casino rejects -> REJECTED then RELEASED, balance restored, stock back, no refund', async () => {
    const { w, item } = setup();
    w.casino.sticky = 'reject';
    const r = await order(w, item.id);
    await w.settle();
    expect(state(w, r.id)).toBe('RELEASED');
    expect(w.casino.rewardCount).toBe(0);
    expect(w.payments.bal('p1')).toEqual({ available: 100, held: 0, captured: 0 });
    expect(w.payments.refunds).toBe(0);
    expect(cmds(w, 'engagement.hold.refund')).toHaveLength(0);
    expect(cmds(w, 'engagement.hold.release').map(opId)).toEqual([`release:${r.id}`]);
    expect(w.store.stockOf(item.id)).toBe(5);
    expect(rec(w, r.id).history.map((h) => h.to)).toEqual([
      'REQUESTED',
      'RESERVED',
      'ISSUING',
      'REJECTED',
      'RELEASED',
    ]);
  });

  // Mutation: set RELEASED when the release command is enqueued instead of when HoldReleased arrives.
  it('I-OUTCOME-4 RELEASED only after payments confirmed; a compensation that cannot be delivered is retried', async () => {
    const { w, item } = setup();
    w.casino.sticky = 'reject';
    const r = await order(w, item.id);
    await w.settle(1); // hold placed, issuing rejected, release queued
    w.payments.down = true;
    await w.settle(6);
    expect(state(w, r.id)).toBe('REJECTED');
    expect(w.payments.releases).toBe(0);
    w.payments.down = false;
    await w.settle();
    expect(state(w, r.id)).toBe('RELEASED');
    expect(w.payments.releases).toBe(1);
    expect(w.payments.bal('p1').available).toBe(100);
  });
});

// ---------------------------------------------------------------------------------------------
describe('I-AMBIGUOUS: a timeout is not a failure; recovery asks the casino by OUR key', () => {
  // Mutation: treat timeout as a final rejection (release on timeout).
  it('I-AMBIGUOUS-1 timeout after the casino issued -> UNKNOWN with coins held, then COMPLETED with one reward', async () => {
    const { w, item } = setup();
    w.casino.plan = ['timeout_effect'];
    const getStatus = jest.spyOn(w.casino, 'getRewardStatus');
    const r = await order(w, item.id);
    await w.settle(1);
    expect(state(w, r.id)).toBe('UNKNOWN');
    expect(w.payments.bal('p1')).toEqual({ available: 90, held: 10, captured: 0 });
    expect(cmds(w, 'engagement.hold.release')).toHaveLength(0);
    expect(cmds(w, 'engagement.hold.capture')).toHaveLength(0);
    await w.settle();
    expect(state(w, r.id)).toBe('COMPLETED');
    expect(w.casino.rewardCount).toBe(1);
    expect(w.casino.issueCalls).toHaveLength(1); // recovered by lookup, not re-issued
    expect(getStatus).toHaveBeenCalledWith(`redeem:${r.id}`);
    expect(w.payments.captures).toBe(1);
  });

  // Mutation: re-issue on UNKNOWN without asking getRewardStatus first.
  it('I-AMBIGUOUS-2 timeout with nothing issued -> lookup says not_found, retry with the SAME key, one reward', async () => {
    const { w, item } = setup();
    w.casino.plan = ['timeout_noeffect'];
    const r = await order(w, item.id);
    await w.settle();
    expect(state(w, r.id)).toBe('COMPLETED');
    expect(w.casino.issueCalls).toHaveLength(2);
    expect(new Set(w.casino.issueCalls.map((c) => c.idempotencyKey))).toEqual(
      new Set([`redeem:${r.id}`]),
    );
    expect(w.casino.rewardCount).toBe(1);
  });

  it('I-AMBIGUOUS-3 two 500s then success -> COMPLETED after three attempts', async () => {
    const { w, item } = setup();
    w.casino.plan = ['error500', 'error500'];
    const r = await order(w, item.id);
    await w.settle();
    expect(state(w, r.id)).toBe('COMPLETED');
    expect(rec(w, r.id).attempts).toBe(3);
    expect(w.casino.issueCalls).toHaveLength(3);
    expect(w.casino.rewardCount).toBe(1);
  });

  // Mutation: map an adapter `unknown` (unlisted rejection code) to REJECTED.
  it('I-AMBIGUOUS-4 an unknown rejection code is retryable, never final', async () => {
    const { w, item } = setup();
    w.casino.plan = ['unknown_code'];
    const r = await order(w, item.id);
    await w.settle(1);
    expect(state(w, r.id)).toBe('UNKNOWN');
    expect(cmds(w, 'engagement.hold.release')).toHaveLength(0);
  });

  // Mutation: raise or remove the attempt cap; auto-release on exhaustion.
  it('I-AMBIGUOUS-5 attempts exhausted -> NEEDS_REVIEW, coins stay held, alert raised; replay ends COMPLETED', async () => {
    const { w, item } = setup();
    w.casino.sticky = 'error500';
    const r = await order(w, item.id);
    await w.settle(60);
    expect(state(w, r.id)).toBe('NEEDS_REVIEW');
    expect(rec(w, r.id).attempts).toBe(8);
    expect(rec(w, r.id).failureReason).toBe('attempts_exhausted');
    expect(w.payments.bal('p1')).toEqual({ available: 90, held: 10, captured: 0 });
    expect(cmds(w, 'engagement.hold.release')).toHaveLength(0);
    expect(cmds(w, 'engagement.redemption.needs_review')).toHaveLength(1);
    w.casino.sticky = 'ok';
    await w.saga.replay(w.tenant, r.id);
    await w.settle();
    expect(state(w, r.id)).toBe('COMPLETED');
    expect(w.casino.rewardCount).toBe(1);
  });

  // Mutation: drop the max-age check (status endpoint stays unknown forever).
  it('I-AMBIGUOUS-6 still unknown after 24 hours -> NEEDS_REVIEW with coins held', async () => {
    const { w, item } = setup();
    w.casino.plan = ['timeout_noeffect'];
    w.casino.statusDown = true;
    const r = await order(w, item.id);
    await w.settle(8, 5 * 60 * 60 * 1000);
    expect(state(w, r.id)).toBe('NEEDS_REVIEW');
    expect(rec(w, r.id).failureReason).toBe('unknown_too_long');
    expect(rec(w, r.id).attempts).toBe(1);
    expect(w.payments.bal('p1').held).toBe(10);
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
    expect(w.casino.rewardCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------------------------
describe('I-DEDUPE and I-LATE: duplicate and late replies', () => {
  // Mutation: remove the inbox dedupe (dedupe key) on payments events.
  it('I-DEDUPE-1 every event and command delivered twice -> one capture, one transition per step', async () => {
    const { w, item } = setup();
    w.duplicateDelivery = true;
    const r = await order(w, item.id);
    await w.settle();
    await w.redeliverAllEvents();
    expect(state(w, r.id)).toBe('COMPLETED');
    expect(w.payments.captures).toBe(1);
    expect(cmds(w, 'engagement.hold.capture')).toHaveLength(1);
    expect(rec(w, r.id).history.map((h) => h.to)).toEqual([
      'REQUESTED',
      'RESERVED',
      'ISSUING',
      'ISSUED',
      'COMPLETED',
    ]);
  });

  // Mutation: let ISSUED -> ISSUED re-enqueue CaptureHold on a repeated report.
  it('I-DEDUPE-2 the success callback sent twice and a late success after UNKNOWN -> ISSUED once, one capture', async () => {
    const { w, item } = setup();
    w.casino.plan = ['timeout_noeffect'];
    const r = await order(w, item.id);
    await w.settle(1);
    expect(state(w, r.id)).toBe('UNKNOWN');
    const report = { outcome: 'issued', reference: 'late-1' } as const;
    await w.saga.onCasinoReport(w.tenant, r.id, report);
    await w.saga.onCasinoReport(w.tenant, r.id, report);
    await w.settle();
    expect(state(w, r.id)).toBe('COMPLETED');
    expect(rec(w, r.id).casinoReference).toBe('late-1');
    expect(cmds(w, 'engagement.hold.capture')).toHaveLength(1);
    expect(w.payments.captures).toBe(1);
  });

  // Mutation: let a late success after RELEASED move coins (capture or re-issue).
  it('I-LATE-1 late success after RELEASED -> NEEDS_REVIEW, alert, no coin movement, reader sees the reason', async () => {
    const { w, item } = setup();
    w.casino.sticky = 'reject';
    const r = await order(w, item.id);
    await w.settle();
    expect(state(w, r.id)).toBe('RELEASED');
    await w.saga.onCasinoReport(w.tenant, r.id, { outcome: 'issued', reference: 'ghost' });
    await w.settle();
    expect(state(w, r.id)).toBe('NEEDS_REVIEW');
    expect(cmds(w, 'engagement.hold.capture')).toHaveLength(0);
    expect(cmds(w, 'engagement.hold.refund')).toHaveLength(0);
    expect(w.payments.bal('p1')).toEqual({ available: 100, held: 0, captured: 0 });
    expect(cmds(w, 'engagement.redemption.needs_review')).toHaveLength(1);
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
    await w.saga.onCasinoReport(w.tenant, r.id, { outcome: 'rejected', code: 'revoked_by_risk' });
    await w.settle();
    expect(state(w, r.id)).toBe('NEEDS_REVIEW');
    expect(rec(w, r.id).failureReason).toBe('late_rejection_after_complete');
    expect(cmds(w, 'engagement.hold.release')).toHaveLength(0);
    expect(w.payments.bal('p1')).toEqual({ available: 90, held: 0, captured: 10 });
  });

  // Mutation: allow CaptureHold after RELEASED to succeed (fake payments) / ignore HoldCommandRejected.
  it('I-LATE-3 a capture rejected as hold_already_released -> NEEDS_REVIEW, ledger conserved', async () => {
    const { w, item } = setup();
    const r = await order(w, item.id);
    await w.settle(1);
    expect(state(w, r.id)).toBe('ISSUED');
    await w.saga.handle(
      createEvent({
        type: 'payments.hold.command_rejected',
        tenantId: w.tenant,
        payload: {
          redemption_id: r.id,
          player_id: 'p1',
          sandbox: false,
          command: 'capture',
          reason: 'hold_already_released',
        },
      }),
    );
    expect(state(w, r.id)).toBe('NEEDS_REVIEW');
    expect(rec(w, r.id).failureReason).toBe('hold_already_released');
    expect(w.payments.total('p1')).toBe(100);
  });

  it('I-LATE-4 a release rejected as hold_already_captured -> NEEDS_REVIEW', async () => {
    const { w, item } = setup();
    w.casino.sticky = 'reject';
    const r = await order(w, item.id);
    await w.settle(1);
    expect(state(w, r.id)).toBe('REJECTED');
    await w.saga.handle(
      createEvent({
        type: 'payments.hold.command_rejected',
        tenantId: w.tenant,
        payload: {
          redemption_id: r.id,
          player_id: 'p1',
          sandbox: false,
          command: 'release',
          reason: 'hold_already_captured',
        },
      }),
    );
    expect(state(w, r.id)).toBe('NEEDS_REVIEW');
    expect(rec(w, r.id).failureReason).toBe('hold_already_captured');
  });
});

// ---------------------------------------------------------------------------------------------
describe('I-REFUND and I-REVIEW: compensation of a captured spend, operator resolution', () => {
  // Mutation: drop the state guard so a second revocation enqueues a second RefundCapture.
  it('I-REFUND-1 revoked reward -> REFUNDED, exactly one refund even with repeated reports and deliveries', async () => {
    const { w, item } = setup();
    w.duplicateDelivery = true;
    const r = await order(w, item.id);
    await w.settle();
    await w.saga.onCasinoReport(w.tenant, r.id, { outcome: 'revoked' });
    await w.saga.onCasinoReport(w.tenant, r.id, { outcome: 'revoked' });
    await w.settle();
    expect(state(w, r.id)).toBe('REFUNDED');
    expect(cmds(w, 'engagement.hold.refund').map(opId)).toEqual([`refund:${r.id}`]);
    expect(w.payments.refunds).toBe(1);
    expect(w.payments.bal('p1')).toEqual({ available: 100, held: 0, captured: 0 });
  });

  async function exhausted() {
    const { w, item } = setup();
    w.casino.sticky = 'error500';
    const r = await order(w, item.id);
    await w.settle(60);
    expect(state(w, r.id)).toBe('NEEDS_REVIEW');
    return { w, r };
  }

  // Mutation: remove the role check in resolveReview.
  it('I-REVIEW-1 only owner/admin resolve; an analyst is forbidden and nothing changes', async () => {
    const { w, r } = await exhausted();
    await expect(
      w.saga.resolveReview(w.tenant, r.id, {
        outcome: 'issued',
        reason: 'looks fine to me',
        operator: { id: 'op', role: 'analyst' },
      }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    expect(state(w, r.id)).toBe('NEEDS_REVIEW');
  });

  it('I-REVIEW-2 operator resolves issued -> capture follows; not_issued -> release follows; the reason is audited', async () => {
    const a = await exhausted();
    await a.w.saga.resolveReview(a.w.tenant, a.r.id, {
      outcome: 'issued',
      reason: 'verified in casino back office',
      operator: { id: 'op-1', role: 'admin' },
    });
    await a.w.settle();
    expect(state(a.w, a.r.id)).toBe('COMPLETED');
    expect(
      rec(a.w, a.r.id).history.some((h) => h.cause.includes('verified in casino back office')),
    ).toBe(true);
    const b = await exhausted();
    await b.w.saga.resolveReview(b.w.tenant, b.r.id, {
      outcome: 'not_issued',
      reason: 'casino confirms no reward',
      operator: { id: 'op-1', role: 'owner' },
    });
    await b.w.settle();
    expect(state(b.w, b.r.id)).toBe('RELEASED');
    expect(b.w.payments.bal('p1').available).toBe(100);
  });
});

// ---------------------------------------------------------------------------------------------
describe('I-CRASH: killed at each durable boundary, the run ends as the no-crash run', () => {
  // [boundary number in MIO-066, kill point, outcome]
  const cases: [number, string, 'ok' | 'reject'][] = [
    [1, 'cmd:place', 'ok'], // after REQUESTED commits, before PlaceHold is relayed
    [2, 'evt:placed', 'ok'], // payments committed the hold, HoldPlaced not yet consumed
    [3, 'after_issuing_committed', 'ok'], // ISSUING committed, adapter not yet called
    [4, 'after_casino_effect', 'ok'], // casino issued, ISSUED not yet recorded
    [5, 'cmd:capture', 'ok'], // ISSUED committed, CaptureHold not yet relayed
    [6, 'evt:captured', 'ok'], // payments captured, HoldCaptured not yet consumed
    [7, 'cmd:release', 'reject'], // REJECTED committed, ReleaseHold not yet relayed
    [8, 'evt:released', 'reject'], // payments released, HoldReleased not yet consumed
  ];

  async function run(kill: string | null, outcome: 'ok' | 'reject') {
    const { w, item } = setup();
    w.casino.sticky = outcome;
    const r = await order(w, item.id);
    if (kill) w.killOnce(kill);
    await w.settle();
    return { w, r, snap: w.snapshot(r.id) };
  }

  // Mutation (one per row): call the adapter before the ISSUING commit (row 3/4, two rewards or none
  // found); write the outbox message outside the transition's transaction (rows 1, 5, 7); drop the
  // sweeper (rows 3, 4); drop the inbox dedupe (rows 2, 6, 8).
  it.each(cases)(
    'I-CRASH-%i killed at %s -> same final state, one reward at most, ledger conserved',
    async (_n, kill, outcome) => {
      const reference = await run(null, outcome);
      const crashed = await run(kill, outcome);
      expect(crashed.w.restarts).toBe(1);
      expect(crashed.snap).toEqual(reference.snap);
      expect(crashed.snap.rewards).toBe(outcome === 'ok' ? 1 : 0);
      expect(crashed.w.payments.total('p1')).toBe(100);
      if (kill === 'after_casino_effect' || kill === 'after_issuing_committed')
        expect(crashed.w.casino.issueCalls.length).toBeLessThanOrEqual(2);
      if (kill === 'after_casino_effect') expect(crashed.w.casino.issueCalls).toHaveLength(1);
      expect(crashed.snap.state).toBe(outcome === 'ok' ? 'COMPLETED' : 'RELEASED');
    },
  );
});

// ---------------------------------------------------------------------------------------------
describe('I-SANDBOX: sandbox redemptions stay in the sandbox and out of metering', () => {
  // Mutation: choose the adapter from anything but the server-side sandbox flag of the order.
  it('I-SANDBOX-1 a sandbox order is issued only to the sandbox adapter; a production order never to it', async () => {
    const { w, item } = setup();
    w.payments.credit('s1', 100);
    const s = await order(w, item.id, 's1', 'ks', true);
    const p = await order(w, item.id, 'p1', 'kp', false);
    await w.settle();
    expect(state(w, s.id)).toBe('COMPLETED');
    expect(state(w, p.id)).toBe('COMPLETED');
    expect(w.sandboxCasino.issueCalls.map((c) => c.playerId)).toEqual(['s1']);
    expect(w.casino.issueCalls.map((c) => c.playerId)).toEqual(['p1']);
  });

  // Mutation: stamp sandbox=false (or omit it) on any outbox message of a sandbox redemption.
  it('I-SANDBOX-2 every event and command of a redemption carries its sandbox flag, true only for sandbox', async () => {
    const { w, item } = setup();
    w.payments.credit('s1', 100);
    const s = await order(w, item.id, 's1', 'ks', true);
    const p = await order(w, item.id, 'p1', 'kp', false);
    await w.settle();
    for (const row of w.store.outbox) {
      const pl = row.envelope.payload as { redemption_id: string; sandbox: boolean };
      expect(pl.sandbox).toBe(pl.redemption_id === s.id);
      expect([s.id, p.id]).toContain(pl.redemption_id);
    }
    expect(w.store.outbox.length).toBeGreaterThan(8);
  });
});
