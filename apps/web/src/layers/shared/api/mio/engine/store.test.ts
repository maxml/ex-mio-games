import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PLANS, WHEEL_REWARDS } from './data';
import { createInitialState, pickReward } from './reducer';
import {
  PAYMENT_MS,
  cancelPayment,
  createStore,
  requestSpin,
  simulateDeposit,
  startPayment,
  startRedeem,
} from './store';

const fresh = () => createStore(createInitialState());
/** One full payment attempt (start then provider answer), replacing the removed legacy invoice/pay action. */
const payNow = (s: ReturnType<typeof fresh>, last4: string, plan = 'growth') => {
  s.dispatch({ type: 'payment/start', id: 'pay-' + last4, plan, last4 });
  s.dispatch({ type: 'payment/settle', id: 'pay-' + last4 });
};

describe('spin: a server-decided result is credited exactly once', () => {
  it('credits the prize and consumes one spin', () => {
    const s = fresh();
    const before = s.get().player;
    s.dispatch({ type: 'player/spin', id: 'sp-1', index: 3 });
    const p = s.get().player;
    expect(p.coins).toBe(before.coins + WHEEL_REWARDS[3].coins);
    expect(p.spins).toBe(before.spins - 1);
    expect(p.history.filter((h) => h.spinId === 'sp-1')).toHaveLength(1);
  });

  it('replaying the same spin id (what a remount used to do) changes nothing', () => {
    const s = fresh();
    s.dispatch({ type: 'player/spin', id: 'sp-1', index: 6 });
    const once = s.get();
    for (let i = 0; i < 3; i++) s.dispatch({ type: 'player/spin', id: 'sp-1', index: 6 });
    expect(s.get()).toBe(once); // same object: no state change at all
  });

  it('subscribing and unsubscribing views (mount, unmount, remount) never moves the balance', () => {
    const s = fresh();
    s.dispatch({ type: 'player/spin', id: 'sp-1', index: 5 });
    const coins = s.get().player.coins;
    for (let i = 0; i < 5; i++) {
      const off = s.subscribe(() => undefined);
      off();
    }
    expect(s.get().player.coins).toBe(coins);
    expect(s.get().player.history.filter((h) => h.spinId)).toHaveLength(1);
  });

  it('does not spin without spins left', () => {
    const s = fresh();
    for (let i = 0; i < 3; i++) s.dispatch({ type: 'player/spin', id: `a${i}`, index: 0 });
    const done = s.get();
    expect(done.player.spins).toBe(0);
    s.dispatch({ type: 'player/spin', id: 'a-extra', index: 6 });
    expect(s.get()).toBe(done);
    expect(requestSpin(s)).toBeNull();
  });

  it('requestSpin credits once and returns the result the wheel animates to', () => {
    const s = fresh();
    const r = requestSpin(s, 0)!;
    expect(r.index).toBe(0);
    expect(s.get().player.coins).toBe(420 + WHEEL_REWARDS[0].coins);
    expect(s.get().player.lastSpin).toEqual(r);
  });
});

describe('operator changes reach the player through the shared state', () => {
  it('published weights decide the next spin', () => {
    const s = fresh();
    const w = WHEEL_REWARDS.map(() => 1);
    w[7] = 1000; // almost everything lands on segment 7
    s.dispatch({ type: 'wheel/publish', weights: w });
    expect(pickReward(s.get().operator.wheel.weights, 0.5)).toBe(7);
    expect(s.get().operator.wheel.version).toBe(4);
  });

  it('publishing with no change or an invalid weight is refused', () => {
    const s = fresh();
    const before = s.get();
    s.dispatch({ type: 'wheel/publish', weights: [...before.operator.wheel.weights] });
    s.dispatch({
      type: 'wheel/publish',
      weights: before.operator.wheel.weights.map((w, i) => (i === 2 ? 0 : w)),
    });
    expect(s.get()).toBe(before);
  });

  it('saved rules decide how many spins a deposit earns; the daily cap applies', () => {
    const s = fresh();
    s.dispatch({ type: 'rules/save', rules: { min: 20, spins: 2, per: true, cap: 5 } });
    expect(simulateDeposit(s, 40)).toBe(4);
    expect(simulateDeposit(s, 40)).toBe(1); // cap of 5 per day reached
    expect(simulateDeposit(s, 40)).toBe(0);
  });

  it('refuses invalid rules and prices', () => {
    const s = fresh();
    const before = s.get();
    s.dispatch({ type: 'rules/save', rules: { min: 0, spins: 1, per: true, cap: 1 } });
    s.dispatch({ type: 'catalog/price', id: 's1', price: -5 });
    expect(s.get()).toBe(before);
  });

  it('a hidden item cannot be redeemed; a new price is what the player pays', () => {
    const s = fresh();
    s.dispatch({ type: 'catalog/visible', id: 's1', on: false });
    expect(startRedeem('s1', s, () => undefined)).toBeNull();
    s.dispatch({ type: 'catalog/visible', id: 's1', on: true });
    s.dispatch({ type: 'catalog/price', id: 's1', price: 100 });
    startRedeem('s1', s, () => undefined);
    expect(s.get().player.coins).toBe(320);
  });
});

describe('redemption lifecycle', () => {
  const run = (down: boolean) => {
    const s = fresh();
    s.dispatch({ type: 'player/casinoDown', on: down });
    const queue: Array<[() => void, number]> = [];
    const id = startRedeem('s1', s, (fn, ms) => queue.push([fn, ms]))!;
    while (queue.length)
      queue
        .sort((a, b) => a[1] - b[1])
        .shift()![0]();
    return { s, id };
  };

  it('issued: coins stay spent', () => {
    const { s } = run(false);
    expect(s.get().player.redemptions[0].status).toBe('issued');
    expect(s.get().player.coins).toBe(420 - 300);
  });

  it('failed: refunded once, and a second refund does nothing', () => {
    const { s, id } = run(true);
    expect(s.get().player.redemptions[0].status).toBe('failed_refunded'); // W-5: the store's public word
    expect(s.get().player.coins).toBe(420);
    const after = s.get();
    s.dispatch({ type: 'redeem/refund', id });
    expect(s.get()).toBe(after);
  });
});

describe('operator flow', () => {
  it('paying the invoice activates the plan; paying twice is a no-op; steps tick only when done', () => {
    const s = fresh();
    expect(Object.values(s.get().operator.done).some(Boolean)).toBe(false);
    payNow(s, '4242');
    const paid = s.get();
    expect(paid.operator.planActive && paid.operator.invoicePaid).toBe(true);
    expect(paid.operator.done.plan).toBe(true);
    expect(paid.operator.done.signup).toBe(false);
    payNow(s, '1111');
    expect(s.get()).toBe(paid);
  });

  it('go live needs an account, a paid plan and a passed sandbox, then a first live deposit', () => {
    const s = fresh();
    s.dispatch({ type: 'live/start' });
    expect(s.get().operator.live).toBe('off');
    s.dispatch({ type: 'account/create' });
    payNow(s, '4242');
    s.dispatch({ type: 'live/start' });
    expect(s.get().operator.live).toBe('off'); // sandbox not passed yet
    s.dispatch({ type: 'sandbox/pass' });
    s.dispatch({ type: 'live/start' });
    expect(s.get().operator.live).toBe('awaiting');
    s.dispatch({ type: 'live/deposit' });
    expect(s.get().operator.live).toBe('live');
    expect(s.get().operator.done.golive).toBe(true);
  });

  it('go live needs a paid plan even with an account and a passed sandbox', () => {
    const s = fresh();
    s.dispatch({ type: 'account/create' });
    s.dispatch({ type: 'sandbox/pass' });
    s.dispatch({ type: 'live/start' });
    expect(s.get().operator.live).toBe('off');
  });

  it('go live needs the sandbox even with an account and a paid plan', () => {
    const s = fresh();
    s.dispatch({ type: 'account/create' });
    payNow(s, '4242');
    s.dispatch({ type: 'live/start' });
    expect(s.get().operator.live).toBe('off');
  });
});

describe('payments: the attempt, its plan and amount, and its outcome live in the store', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());
  const starter = PLANS.find((p) => p.id === 'starter')!;
  const growth = PLANS.find((p) => p.id === 'growth')!;

  it('a successful attempt pays the plan and the amount it was started for', () => {
    const s = fresh();
    s.dispatch({ type: 'plan/select', id: 'growth' });
    startPayment('growth', '4242', s);
    vi.advanceTimersByTime(PAYMENT_MS);
    const o = s.get().operator;
    expect(o.invoicePaid && o.planActive).toBe(true);
    expect([o.paidPlan, o.paidAmount]).toEqual(['growth', growth.price]);
    expect(o.payment?.status).toBe('paid');
  });

  it('cancel aborts the attempt: no timer outlives it and nothing is paid', () => {
    const s = fresh();
    const id = startPayment('growth', '4242', s)!;
    expect(vi.getTimerCount()).toBe(1);
    cancelPayment(id, s);
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(PAYMENT_MS * 5);
    expect(s.get().operator.invoicePaid).toBe(false);
    expect(s.get().operator.payment?.status).toBe('cancelled');
  });

  it('a late provider answer for a cancelled attempt never pays (reducer level)', () => {
    const s = fresh();
    s.dispatch({ type: 'payment/start', id: 'p1', plan: 'growth', last4: '4242' });
    s.dispatch({ type: 'payment/cancel', id: 'p1' });
    s.dispatch({ type: 'payment/settle', id: 'p1' });
    expect(s.get().operator.invoicePaid).toBe(false);
  });

  it('cancel, change plan, pay again: the paid plan and amount are the ones charged', () => {
    const s = fresh();
    const id = startPayment('growth', '4242', s)!;
    cancelPayment(id, s);
    s.dispatch({ type: 'plan/select', id: 'starter' });
    startPayment('starter', '4242', s);
    vi.advanceTimersByTime(PAYMENT_MS);
    expect([s.get().operator.paidPlan, s.get().operator.paidAmount]).toEqual([
      'starter',
      starter.price,
    ]);
  });

  it('the plan cannot change while an attempt is in flight, nor after payment', () => {
    const s = fresh();
    s.dispatch({ type: 'plan/select', id: 'growth' });
    startPayment('growth', '4242', s);
    s.dispatch({ type: 'plan/select', id: 'starter' });
    expect(s.get().operator.plan).toBe('growth');
    vi.advanceTimersByTime(PAYMENT_MS);
    s.dispatch({ type: 'plan/select', id: 'scale' });
    const o = s.get().operator;
    expect([o.plan, o.paidPlan, o.paidAmount]).toEqual(['growth', 'growth', growth.price]);
  });

  it('the amount comes from the price list, and a second attempt while one is in flight is refused', () => {
    const s = fresh();
    startPayment('scale', '4242', s);
    const first = s.get().operator.payment!;
    expect(first.amount).toBe(PLANS.find((p) => p.id === 'scale')!.price);
    expect(startPayment('starter', '4242', s)).toBeNull();
    expect(s.get().operator.payment).toBe(first);
  });

  it('the decline is decided in the store: the declined card is never marked paid', () => {
    const s = fresh();
    payNow(s, '0002');
    expect(s.get().operator.invoicePaid).toBe(false);
    startPayment('growth', '0002', s);
    vi.advanceTimersByTime(PAYMENT_MS);
    expect(s.get().operator.invoicePaid).toBe(false);
    expect(s.get().operator.planActive).toBe(false);
    expect(s.get().operator.payment?.status).toBe('declined');
    // and the operator can try again with a good card
    startPayment('growth', '4242', s);
    vi.advanceTimersByTime(PAYMENT_MS);
    expect(s.get().operator.invoicePaid).toBe(true);
  });
});
