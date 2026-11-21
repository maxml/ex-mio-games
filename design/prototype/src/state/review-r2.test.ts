// Reviewer regression specs r2. Written by the reviewer, not the author. Do not edit.
import { describe, expect, it } from 'vitest';
import { createInitialState } from './reducer';
import { createStore } from './store';

const fresh = () => createStore(createInitialState());

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
    s.dispatch({ type: 'invoice/pay', last4: '4242' });
    s.dispatch({ type: 'sandbox/pass' });
    s.dispatch({ type: 'live/start' });
    expect(s.get().operator.live).toBe('off');
  });
});
