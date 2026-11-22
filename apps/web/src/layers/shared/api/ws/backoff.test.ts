import { describe, expect, it } from 'vitest';
import {
  computeBackoffDelay,
  RECONNECTION_BASE_DELAY_MS,
  RECONNECTION_JITTER,
  RECONNECTION_MAX_ATTEMPTS,
  RECONNECTION_MAX_DELAY_MS,
  reconnectionOptions,
} from './backoff';

// Backoff schedule (ADR-0014 §6). `random: () => 0.5` zeroes the symmetric
// jitter (0.5 * 2 - 1 === 0), so the deterministic exponential part is exact.
const noJitter = { random: () => 0.5 };

describe('computeBackoffDelay', () => {
  it('grows exponentially from the base delay (jitter neutralised)', () => {
    expect(computeBackoffDelay(0, noJitter)).toBe(RECONNECTION_BASE_DELAY_MS); // 1000
    expect(computeBackoffDelay(1, noJitter)).toBe(2_000);
    expect(computeBackoffDelay(2, noJitter)).toBe(4_000);
    expect(computeBackoffDelay(3, noJitter)).toBe(8_000);
  });

  it('caps the deterministic delay at the configured max (~30s)', () => {
    // 1000 * 2 ** 20 would be ~1e9; the cap holds it at the max.
    expect(computeBackoffDelay(20, noJitter)).toBe(RECONNECTION_MAX_DELAY_MS);
  });

  it('applies symmetric jitter within ±jitter of the capped value', () => {
    const capped = 4_000; // attempt 2, below the cap
    const low = computeBackoffDelay(2, { random: () => 0 }); // -1 * jitter
    const high = computeBackoffDelay(2, { random: () => 1 - 1e-9 }); // ~ +1 * jitter
    expect(low).toBe(Math.round(capped * (1 - RECONNECTION_JITTER)));
    expect(high).toBeGreaterThan(capped);
    expect(high).toBeLessThanOrEqual(Math.round(capped * (1 + RECONNECTION_JITTER)));
  });

  it('never returns a negative delay', () => {
    for (let attempt = 0; attempt < 15; attempt += 1) {
      expect(computeBackoffDelay(attempt, { random: () => 0 })).toBeGreaterThanOrEqual(0);
    }
  });

  it('exposes a give-up bound and the cap to socket.io via reconnectionOptions', () => {
    expect(reconnectionOptions.reconnection).toBe(true);
    expect(reconnectionOptions.reconnectionDelay).toBe(RECONNECTION_BASE_DELAY_MS);
    expect(reconnectionOptions.reconnectionDelayMax).toBe(RECONNECTION_MAX_DELAY_MS);
    expect(reconnectionOptions.randomizationFactor).toBe(RECONNECTION_JITTER);
    expect(reconnectionOptions.reconnectionAttempts).toBe(RECONNECTION_MAX_ATTEMPTS);
  });
});
