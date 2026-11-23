import { REQUEST_GRACE_MS } from '../../model/redemption.store';
import { TestClock } from './clock';

/*
 * Flaky F5 (review/flaky-f5-d16): the Postgres contract suites share the database with a live stack
 * whose engagement worker claims work-queue rows due by the REAL clock. A test order is due at
 * `clock + REQUEST_GRACE_MS`, so the default test clock must stay far ahead of the real one, or the
 * worker rejects the test's orders and restores their stock mid-test (F5: stock 89 for 88).
 * Mutation: set the default back to any date within a year of today (it was 2026-11-22T10:00Z) -> red.
 */
describe('TestClock default never puts a test order in the live worker’s due window', () => {
  it('starts more than 100 years ahead of the real clock, grace included', () => {
    const due = new TestClock().now().getTime() + REQUEST_GRACE_MS;
    const century = 100 * 365 * 24 * 3600 * 1000;
    expect(due - Date.now()).toBeGreaterThan(century);
  });

  it('two default clocks are independent (advancing one does not move the default)', () => {
    const a = new TestClock();
    a.advance(60_000);
    expect(new TestClock().now().getTime()).toBe(a.now().getTime() - 60_000);
  });
});
