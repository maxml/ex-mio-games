import { ISSUING_LEASE_MS, MAX_ATTEMPTS, MAX_UNKNOWN_AGE_MS, backoffDelayMs } from './backoff';

// Invariant I-RETRY-1 (MIO-068): bounded attempts, exponential backoff with jitter, capped.
// Mutation: remove the cap, make the delay constant, or change MAX_ATTEMPTS -> the matching test goes red.
describe('issuance backoff policy', () => {
  it('the budget is 8 attempts and 24 hours in UNKNOWN', () => {
    expect(MAX_ATTEMPTS).toBe(8);
    expect(MAX_UNKNOWN_AGE_MS).toBe(24 * 60 * 60 * 1000);
    expect(ISSUING_LEASE_MS).toBe(60_000);
  });

  it('grows exponentially up to a cap of 5 minutes (jitter at its maximum)', () => {
    const d = Array.from({ length: 10 }, (_, i) => backoffDelayMs(i + 1, () => 1));
    expect(d[0]).toBe(1_000);
    expect(d[1]).toBe(2_000);
    expect(d[2]).toBe(4_000);
    for (let i = 1; i < d.length; i++) expect(d[i]!).toBeGreaterThanOrEqual(d[i - 1]!);
    expect(Math.max(...d)).toBe(300_000);
  });

  it('is full jitter: between zero and the exponential value', () => {
    expect(backoffDelayMs(3, () => 0)).toBe(0);
    expect(backoffDelayMs(3, () => 0.5)).toBe(2_000);
    for (let i = 0; i < 50; i++) {
      const v = backoffDelayMs(5, Math.random);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(16_000);
    }
  });
});
