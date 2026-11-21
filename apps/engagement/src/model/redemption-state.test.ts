import { REDEMPTION_STATUSES, PUBLIC_STATUS_OF } from '@ex-mio/contracts';
import {
  IllegalTransitionError,
  REDEMPTION_TRANSITIONS,
  assertTransition,
  canTransition,
} from './redemption-state';
import { ORACLE_TRANSITIONS, isOracleLegal } from '../redemptions/testing/transition-oracle';

const key = ([a, b]: readonly [string, string]) => `${a}>${b}`;

// Choke point: model/redemption-state.ts (`assertTransition`, used by the store's `apply`).
// Invariant I-STATE-1 (MIO-067): every pair outside the table is rejected; the code's table equals the spec table.
// Mutation: add or drop one row in REDEMPTION_TRANSITIONS, or make assertTransition return
// instead of throw -> the table-equality test and the all-pairs test go red.
describe('redemption transition table', () => {
  it('equals the MIO-066 table typed out in the oracle, row for row', () => {
    expect(REDEMPTION_TRANSITIONS.map(key).sort()).toEqual(ORACLE_TRANSITIONS.map(key).sort());
  });

  it('rejects every one of the 121 pairs that is not in the table, accepts every one that is', () => {
    let rejected = 0;
    for (const from of REDEMPTION_STATUSES) {
      for (const to of REDEMPTION_STATUSES) {
        if (isOracleLegal(from, to)) {
          expect(canTransition(from, to)).toBe(true);
          expect(() => assertTransition(from, to)).not.toThrow();
        } else {
          expect(canTransition(from, to)).toBe(false);
          expect(() => assertTransition(from, to)).toThrow(IllegalTransitionError);
          rejected += 1;
        }
      }
    }
    expect(rejected).toBe(121 - ORACLE_TRANSITIONS.length);
  });

  it('final states have no way out except the documented review and refund rows', () => {
    const outOf = (s: string) => ORACLE_TRANSITIONS.filter(([f]) => f === s).map(([, t]) => t);
    expect(outOf('REFUNDED')).toEqual([]);
    expect(outOf('REJECTED_FUNDS')).toEqual([]);
    expect(outOf('RELEASED')).toEqual(['NEEDS_REVIEW']);
    expect(outOf('COMPLETED').sort()).toEqual(['NEEDS_REVIEW', 'REFUNDED']);
  });

  it('every state has a public status', () => {
    for (const s of REDEMPTION_STATUSES) expect(PUBLIC_STATUS_OF[s]).toBeDefined();
  });
});
