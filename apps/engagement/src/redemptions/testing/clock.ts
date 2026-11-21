import type { Clock } from '../ports';

/** A clock the tests move by hand. */
export class TestClock implements Clock {
  constructor(public t = new Date('2026-11-22T10:00:00.000Z')) {}
  now(): Date {
    return new Date(this.t);
  }
  advance(ms: number): void {
    this.t = new Date(this.t.getTime() + ms);
  }
}
