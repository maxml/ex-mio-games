import type { Clock } from '../ports';

/**
 * Far ahead of the real clock, on purpose. The Postgres contract suites write into the database of a
 * LIVE stack (CI), whose engagement worker claims work-queue rows due by the REAL clock. An order is
 * due at `clock + REQUEST_GRACE_MS`; with a start in the past (this was 2026-11-22T10:00Z, which the
 * real clock passed on that day) every test order was due at once, the worker asked payments for the
 * coins, the test player had none, REJECTED_FUNDS restored the unit, and F5 read stock 89 for 88.
 * Tests use the clock only relative to `now()`, so the absolute date is free to choose.
 */
export const TEST_CLOCK_START = new Date('2999-01-01T10:00:00.000Z');

/** A clock the tests move by hand. */
export class TestClock implements Clock {
  constructor(public t = new Date(TEST_CLOCK_START)) {}
  now(): Date {
    return new Date(this.t);
  }
  advance(ms: number): void {
    this.t = new Date(this.t.getTime() + ms);
  }
}
