import { describe, expect, it } from 'vitest';
import { WHEEL_REWARDS } from '../mock/data';
import { createInitialState, pickReward } from './reducer';
import { createStore, requestSpin, simulateDeposit, startRedeem } from './store';

const fresh = () => createStore(createInitialState());

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
    s.dispatch({ type: 'wheel/publish', weights: before.operator.wheel.weights.map((w, i) => (i === 2 ? 0 : w)) });
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
    while (queue.length) queue.sort((a, b) => a[1] - b[1]).shift()![0]();
    return { s, id };
  };

  it('issued: coins stay spent', () => {
    const { s } = run(false);
    expect(s.get().player.redemptions[0].status).toBe('issued');
    expect(s.get().player.coins).toBe(420 - 300);
  });

  it('failed: refunded once, and a second refund does nothing', () => {
    const { s, id } = run(true);
    expect(s.get().player.redemptions[0].status).toBe('refunded');
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
    s.dispatch({ type: 'invoice/pay', last4: '4242' });
    const paid = s.get();
    expect(paid.operator.planActive && paid.operator.invoicePaid).toBe(true);
    expect(paid.operator.done.plan).toBe(true);
    expect(paid.operator.done.signup).toBe(false);
    s.dispatch({ type: 'invoice/pay', last4: '1111' });
    expect(s.get()).toBe(paid);
  });

  it('go live needs a passed sandbox, then a first live deposit', () => {
    const s = fresh();
    s.dispatch({ type: 'live/start' });
    expect(s.get().operator.live).toBe('off');
    s.dispatch({ type: 'sandbox/pass' });
    s.dispatch({ type: 'live/start' });
    expect(s.get().operator.live).toBe('awaiting');
    s.dispatch({ type: 'live/deposit' });
    expect(s.get().operator.live).toBe('live');
    expect(s.get().operator.done.golive).toBe(true);
  });
});
