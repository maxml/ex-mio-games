// Reconnect backoff policy for the singleton socket (ADR-0014 §6):
// exponential backoff with jitter, a ~30s cap, and a give-up bound. socket.io's
// Manager implements this math natively, so `reconnectionOptions` configures it
// directly; `computeBackoffDelay` mirrors the same formula as a pure, testable
// helper (and documents the schedule the Manager follows). The cap is kept in
// the same ballpark as the gateway's `pingInterval`/`pingTimeout`
// (the realtime gateway) so client and server don't fight over
// dead-connection detection.

/** Initial delay before the first reconnection attempt. */
export const RECONNECTION_BASE_DELAY_MS = 1_000;
/** Upper bound on the (pre-jitter) delay — caps the exponential growth at ~30s. */
export const RECONNECTION_MAX_DELAY_MS = 30_000;
/** Jitter spread (socket.io `randomizationFactor`): delay is ±this fraction. */
export const RECONNECTION_JITTER = 0.5;
/** Give-up bound: stop retrying after this many consecutive failures. */
export const RECONNECTION_MAX_ATTEMPTS = 12;

export interface BackoffOptions {
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Jitter fraction in [0, 1]. */
  jitter?: number;
  /** Injectable RNG in [0, 1) for deterministic tests; defaults to `Math.random`. */
  random?: () => number;
}

/**
 * Delay (ms) before reconnection attempt `attempt` (0-based). The deterministic
 * part grows as `base * 2 ** attempt`, capped at `maxDelayMs`; symmetric jitter
 * of ±`jitter * capped` is then applied. Never negative.
 */
export function computeBackoffDelay(attempt: number, options: BackoffOptions = {}): number {
  const base = options.baseDelayMs ?? RECONNECTION_BASE_DELAY_MS;
  const max = options.maxDelayMs ?? RECONNECTION_MAX_DELAY_MS;
  const jitter = options.jitter ?? RECONNECTION_JITTER;
  const random = options.random ?? Math.random;

  const exponential = Math.min(base * 2 ** Math.max(0, attempt), max);
  // `random() * 2 - 1` maps [0, 1) -> [-1, 1): symmetric jitter, like the Manager.
  const delta = exponential * jitter * (random() * 2 - 1);
  return Math.max(0, Math.round(exponential + delta));
}

/**
 * socket.io Manager options that encode the policy above. Spread into `io(...)`
 * so the library owns the actual reconnection scheduling (exponential backoff +
 * jitter, capped, with a give-up bound).
 */
export const reconnectionOptions = {
  reconnection: true,
  reconnectionDelay: RECONNECTION_BASE_DELAY_MS,
  reconnectionDelayMax: RECONNECTION_MAX_DELAY_MS,
  randomizationFactor: RECONNECTION_JITTER,
  reconnectionAttempts: RECONNECTION_MAX_ATTEMPTS,
} as const;
