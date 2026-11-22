---
id: MIO-101
title: Analytics emitter under the Varta contract, with an honest delivery guarantee
epic: EPIC-10
priority: P0
money_impact: enabler
risk_class: guard
status: todo
depends_on: [MIO-100, MIO-013]
blocked_by: ['starter: analytics emitter', 'starter: event bus (outbox, inbox, DLQ) on RabbitMQ']
size: M
---

## Goal

Every service can emit product events with one call, the product does not break when Varta is down, and
the numbers we sell on (funnel steps, plan activations) are neither lost nor invented.

## Scope

Two delivery classes, stated in the taxonomy (MIO-100) for every event:

- **Business events** (funnel steps, deposits, spins, redemptions, plan changes): written as an
  analytics intent row in the **same database transaction** as the business change (the service's
  outbox). A relay delivers them to the sink at least once and retries until acknowledged. Each has a
  deterministic `event_id` (from tenant, step and business id), and every read (funnel query, Varta
  panel) counts distinct `event_id`. Result: committed changes always produce the event; rolled-back
  changes never do; duplicates are invisible to readers. We do not claim exactly-once delivery; we claim
  exactly-once counting.
- **Behavioural events** (widget opened, button clicks, frontend events): best effort, written to the log
  line sink without a transaction; may be lost on a crash. Never used for billing or for the funnel steps
  above.
- Default sink: one structured JSON line per event through the existing logger, as Varta's telemetry
  contract expects; Varta collects it from there. The relay writes business events the same way after
  their transaction committed.
- `track(event)` with the typed registry, validation and a consent check; `memory` sink for unit tests.
- Business events are `essential`; behavioural events need consent.

## Acceptance criteria

- **Commit, then crash before the log line:** after restart the relay emits the event once.
- **Write, then rollback:** no event is emitted.
- **Relay retries after a sink failure:** the event is written twice; the funnel query counts it once.
- With the memory sink, a test asserts the exact event emitted by a use case.
- An event with `consent: "analytics"` for an actor who has not opted in is dropped and counted.
- Stopping Varta has no effect on the product (no synchronous network call from the emitter).
- No email, IP address or payment data can appear in an event (validation test with such fields).
- Mutation: emit a business event outside the transaction (the rollback test goes red).
