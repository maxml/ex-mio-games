/** Issuance retry policy (spec 4.3). */
export const MAX_ATTEMPTS = 8;
export const MAX_UNKNOWN_AGE_MS = 24 * 60 * 60 * 1000;
export const ISSUING_LEASE_MS = 60_000;

/** How often an undecided lookup (pending, or a status endpoint that does not answer) is repeated. */
export const POLL_INTERVAL_MS = 60_000;
/** How soon a payments call that failed in transport is repeated (same key). */
export const PAYMENTS_RETRY_MS = 30_000;

const BASE_MS = 1_000;
const CAP_MS = 300_000;

/** Full jitter: between zero and min(5 min, 1 s * 2^(attempt-1)). `random` returns [0, 1]. */
export function backoffDelayMs(attempt: number, random: () => number): number {
  const exp = Math.min(CAP_MS, BASE_MS * 2 ** Math.max(0, attempt - 1));
  return Math.floor(random() * exp);
}
