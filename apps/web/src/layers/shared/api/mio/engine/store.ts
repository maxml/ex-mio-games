import { createInitialState, pickReward, reducer, type Action, type State } from './reducer';

export interface Store {
  get: () => State;
  dispatch: (a: Action) => void;
  subscribe: (fn: () => void) => () => void;
}

/** Tiny external store. It lives outside React, so mounting and unmounting views never changes it. */
export function createStore(initial: State = createInitialState()): Store {
  let state = initial;
  const subs = new Set<() => void>();
  return {
    get: () => state,
    dispatch: (a) => {
      const next = reducer(state, a);
      if (next === state) return;
      state = next;
      subs.forEach((f) => f());
    },
    subscribe: (fn) => {
      subs.add(fn);
      return () => subs.delete(fn);
    },
  };
}

export const appStore = createStore();

let seq = 0;
const uid = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${++seq}`;

/**
 * Stand-in for POST /spin. The "server" decides the result (published weights) and gives it an id;
 * the player is credited right here, once. The UI then only animates `result`.
 * Returns null when there was nothing to spin (no spins left).
 */
export function requestSpin(store: Store = appStore, rnd: number = Math.random()) {
  const before = store.get().player;
  if (before.spins < 1) return null;
  const id = uid('spin');
  const index = pickReward(store.get().operator.wheel.weights, rnd);
  store.dispatch({ type: 'player/spin', id, index });
  const { lastSpin } = store.get().player;
  return lastSpin && lastSpin.id === id ? lastSpin : null;
}

/** Stand-in for the casino reporting a deposit. Returns the number of spins it earned. */
export function simulateDeposit(store: Store = appStore, eur = 40): number {
  const before = store.get().player.spins;
  store.dispatch({ type: 'player/deposit', eur });
  return store.get().player.spins - before;
}

/** Provider round trip of the fake payment provider. */
export const PAYMENT_MS = 1100;
const paymentTimers = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * Stand-in for starting a payment at the provider. The attempt (plan, amount, card) is recorded in
 * the store; the provider answers after PAYMENT_MS and the reducer decides paid or declined.
 * Returns the attempt id, or null when the reducer refused to start one.
 */
export function startPayment(plan: string, last4: string, store: Store = appStore): string | null {
  const id = uid('pay');
  store.dispatch({ type: 'payment/start', id, plan, last4 });
  if (store.get().operator.payment?.id !== id) return null;
  paymentTimers.set(
    id,
    setTimeout(() => {
      paymentTimers.delete(id);
      store.dispatch({ type: 'payment/settle', id });
    }, PAYMENT_MS),
  );
  return id;
}

/** Cancel an attempt in flight: the store marks it cancelled and its provider answer is dropped. */
export function cancelPayment(id: string, store: Store = appStore): void {
  const t = paymentTimers.get(id);
  if (t !== undefined) clearTimeout(t);
  paymentTimers.delete(id);
  store.dispatch({ type: 'payment/cancel', id });
}

/**
 * Redemption lifecycle (pending, issuing, issued or failed then refunded). The timers live here,
 * not in a component, so leaving the widget never strands a redemption half-way.
 */
export function startRedeem(
  itemId: string,
  store: Store = appStore,
  wait: (fn: () => void, ms: number) => void = (fn, ms) => void setTimeout(fn, ms),
) {
  const id = uid('rd');
  const down = store.get().player.casinoDown; // decided when the player clicks
  store.dispatch({ type: 'redeem/start', id, itemId });
  if (!store.get().player.redemptions.some((r) => r.id === id)) return null;
  wait(() => store.dispatch({ type: 'redeem/status', id, status: 'issuing' }), 1200);
  wait(() => {
    if (!down) return store.dispatch({ type: 'redeem/status', id, status: 'issued' });
    store.dispatch({ type: 'redeem/status', id, status: 'failed' });
    wait(() => store.dispatch({ type: 'redeem/refund', id }), 1400);
  }, 2600);
  return id;
}
