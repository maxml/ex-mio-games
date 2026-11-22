// Reviewer regression specs r2. Written by the reviewer, not the author. Do not edit.
import { describe, expect, it } from 'vitest';
import { createInitialState } from './reducer';
import { createStore } from './store';

const fresh = () => createStore(createInitialState());
/** One full payment attempt (start then provider answer), replacing the removed legacy invoice/pay action. */
const payNow = (s: ReturnType<typeof fresh>, last4: string, plan = 'growth') => {
  s.dispatch({ type: 'payment/start', id: 'pay-' + last4, plan, last4 });
  s.dispatch({ type: 'payment/settle', id: 'pay-' + last4 });
};

describe('operator flow', () => {
  it('cannot go live without a paid plan, whatever route the UI takes', () => {
    const s = fresh();
    s.dispatch({ type: 'sandbox/pass' });
    s.dispatch({ type: 'live/start' });
    s.dispatch({ type: 'live/deposit' });
    expect(s.get().operator.live).toBe('off');
  });
  it('cannot go live without an account', () => {
    const s = fresh();
    payNow(s, '4242');
    s.dispatch({ type: 'sandbox/pass' });
    s.dispatch({ type: 'live/start' });
    expect(s.get().operator.live).toBe('off');
  });
});
