// Client-side previews of what the server decides. They only drive helper text and button state; the
// server (and the mock engine standing in for it) is the authority and re-validates every write.
import type { RulesView } from '../types';

export const rulesValid = (r: RulesView): boolean =>
  [r.min, r.spins, r.cap].every((n) => Number.isInteger(n) && n >= 1);

export const weightsValid = (w: number[]): boolean =>
  w.length > 0 && w.every((x) => Number.isFinite(x) && x > 0);

export const sameWeights = (a: number[], b: number[]): boolean =>
  a.length === b.length && a.every((x, i) => x === b[i]);

/** How many spins a deposit earns under the rules, before the daily cap. */
export function spinsForDeposit(r: RulesView, eur: number): number {
  return r.per ? Math.floor(eur / r.min) * r.spins : eur >= r.min ? r.spins : 0;
}

/** Expected coins per spin for a table of rewards and a weight vector in the same order. */
export function expectedPayout(coins: number[], weights: number[]): number {
  const total = weights.reduce((a, b) => a + b, 0);
  return total > 0 ? coins.reduce((s, c, i) => s + (c * (weights[i] ?? 0)) / total, 0) : 0;
}
