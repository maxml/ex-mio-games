import type { RedemptionState } from '@ex-mio/contracts';

/**
 * The test oracle: the redemption state-transition table of backlog MIO-066,
 * one entry per row, typed out by hand. It is deliberately NOT imported from
 * the implementation. The implementation's exported table must equal this one.
 */
export const ORACLE_TRANSITIONS: ReadonlyArray<readonly [RedemptionState, RedemptionState]> = [
  ['REQUESTED', 'RESERVED'], // HoldPlaced
  ['REQUESTED', 'REJECTED_FUNDS'], // reserve answered 409 insufficient_funds
  // EXTENSION (spec §3, F10): a reserve whose answer does not match our order (other amount, or a
  // refusal other than insufficient_funds) must not strand held coins in REQUESTED forever.
  ['REQUESTED', 'NEEDS_REVIEW'],
  ['RESERVED', 'ISSUING'], // issue job starts
  ['ISSUING', 'ISSUED'], // adapter success
  ['ISSUING', 'REJECTED'], // adapter definitive rejection
  ['ISSUING', 'UNKNOWN'], // timeout, 5xx, network, unparseable
  ['UNKNOWN', 'ISSUED'], // inquiry: issued
  ['UNKNOWN', 'ISSUING'], // inquiry: no record, attempts left
  ['UNKNOWN', 'REJECTED'], // inquiry: definitive rejection
  ['UNKNOWN', 'NEEDS_REVIEW'], // max age or attempts exhausted
  ['ISSUED', 'COMPLETED'], // HoldCaptured
  ['REJECTED', 'RELEASED'], // HoldReleased
  ['COMPLETED', 'REFUNDED'], // casino revoked / audited compensation
  ['REJECTED', 'NEEDS_REVIEW'], // late success
  ['RELEASED', 'NEEDS_REVIEW'], // late success
  ['ISSUED', 'NEEDS_REVIEW'], // late rejection / hold command rejected
  ['COMPLETED', 'NEEDS_REVIEW'], // late rejection
  ['NEEDS_REVIEW', 'ISSUED'], // operator: issued
  ['NEEDS_REVIEW', 'REJECTED'], // operator: not_issued
  // EXTENSION of the MIO-066 table (spec §3, decision D1): `replay` of an exhausted redemption
  // re-enters the unknown path with a fresh attempt budget, so MIO-068's "replay ends COMPLETED" holds.
  // `apply` allows this pair ONLY when the review was entered from UNKNOWN (D-8): the pair alone
  // is legal, the pair plus its history is the rule. See the conformance suite.
  ['NEEDS_REVIEW', 'UNKNOWN'],
];

export const isOracleLegal = (from: RedemptionState, to: RedemptionState): boolean =>
  ORACLE_TRANSITIONS.some(([f, t]) => f === from && t === to);
