import type { RedemptionState } from '@ex-mio/contracts';

/**
 * The redemption state machine (spec section 2): 19 rows of MIO-066 plus `REQUESTED -> NEEDS_REVIEW`
 * and `NEEDS_REVIEW -> UNKNOWN` (replay). The second one is legal as a pair only; the store's `apply`
 * adds the history guard that makes it legal for a review entered from UNKNOWN.
 * This is the single table: `assertTransition` is called by `RedemptionStore.apply`.
 */
export const REDEMPTION_TRANSITIONS: ReadonlyArray<readonly [RedemptionState, RedemptionState]> = [
  ['REQUESTED', 'RESERVED'],
  ['REQUESTED', 'REJECTED_FUNDS'],
  ['REQUESTED', 'NEEDS_REVIEW'],
  ['RESERVED', 'ISSUING'],
  ['ISSUING', 'ISSUED'],
  ['ISSUING', 'REJECTED'],
  ['ISSUING', 'UNKNOWN'],
  ['UNKNOWN', 'ISSUED'],
  ['UNKNOWN', 'ISSUING'],
  ['UNKNOWN', 'REJECTED'],
  ['UNKNOWN', 'NEEDS_REVIEW'],
  ['ISSUED', 'COMPLETED'],
  ['REJECTED', 'RELEASED'],
  ['COMPLETED', 'REFUNDED'],
  ['REJECTED', 'NEEDS_REVIEW'],
  ['RELEASED', 'NEEDS_REVIEW'],
  ['ISSUED', 'NEEDS_REVIEW'],
  ['COMPLETED', 'NEEDS_REVIEW'],
  ['NEEDS_REVIEW', 'ISSUED'],
  ['NEEDS_REVIEW', 'REJECTED'],
  ['NEEDS_REVIEW', 'UNKNOWN'],
];

/** Thrown for a (from, to) pair outside the table and for a replay the history does not allow. */
export class IllegalTransitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IllegalTransitionError';
  }
}

export const canTransition = (from: RedemptionState, to: RedemptionState): boolean =>
  REDEMPTION_TRANSITIONS.some(([f, t]) => f === from && t === to);

export function assertTransition(from: RedemptionState, to: RedemptionState): void {
  if (!canTransition(from, to))
    throw new IllegalTransitionError(`illegal transition ${from} -> ${to}`);
}
