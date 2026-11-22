---
id: MIO-216
title: Outbox events with no bound queue are retried forever
epic: EPIC-07
priority: P1
money_impact: none
risk_class: concurrency
status: todo
depends_on: [MIO-056, MIO-145]
size: M
estimate_hours_base: 10
estimate_hours: 12
---

## Goal

An event that no queue is bound to is either delivered to a declared sink or parked with a reason, and
never retried for ever. After the first full run, engagement held 27 unpublished outbox rows with
`last_error` "unroutable: no queue is bound to this event type" (`redemption.*` and `spin.granted`).
They were retried and never parked.

## Scope

- Decide per event type: a declared sink (a queue that is bound on purpose, even if no service consumes it
  yet) or an explicit "no consumer yet" list. An event type that is in neither is a startup or test failure.
- Park an unroutable row after N attempts (N is configuration, with a default), with a reason that names the
  event type and the attempt count, and leave it visible to the existing dead-letter replay.
- Backoff between attempts grows and is capped; a batch of unroutable rows must not be retried in a tight loop
  or hold back routable rows behind it.
- Count parked events: a metric or a structured log line per parked row (event type, attempts, reason).

## Acceptance criteria

- An unroutable event is either published to a declared sink or parked with a reason after N attempts; no
  row stays unpublished and unparked past N attempts.
- There is no hot retry loop: the gap between two attempts of one row is at least the configured backoff,
  and a test with a fake clock asserts that the attempt count after a fixed window stays at or below the
  bound.
- A metric or a log line counts parked events, and a test reads it after a row is parked.
- A compose test publishes an event type with no consumer and asserts that the row is parked (`parked_at`
  set, reason stored), not retried forever, and that a routable event published after it is delivered.
- Mutation: remove the park branch (or set N to infinity). The compose test goes red.

## Notes

Source: the first full compose run (engagement outbox, 27 rows). `packages/bus/src/outbox.ts` already has a
park branch after `maxAttempts`; find out why these rows were not parked (the default, the engagement
wiring, or rows written before the branch existed) before changing the mechanism. Related: MIO-205 (an
unmarked outbox row after a broker disconnect, a different symptom).
