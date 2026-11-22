---
id: MIO-205
title: Investigate a payments readiness 503 and an unmarked outbox row after a broker disconnect
epic: EPIC-14
priority: P1
money_impact: none
risk_class: concurrency
status: todo
depends_on: [MIO-056, MIO-145, MIO-162]
size: M
estimate_hours_base: 16
estimate_hours: 20
---

## Goal

Find out whether a real defect sits behind two symptoms seen once and not reproduced: the payments
`/healthz/ready` stayed 503 after every broker connection was closed, and an outbox row stayed with
`published_at` null although its message was published and applied.

## Scope

- A repro harness: a loop of broker connection closes, broker restarts and network pauses, under a steady
  publish load on every service, for a fixed time (soak or stress; 30 minutes by default).
- Sampling of readiness per service, unsent outbox rows and their age, and the relay's logs.
- If a defect is found: a failing test first, then the fix. If none is found: a written result with the run
  parameters, kept in the repository.

## Acceptance criteria

- The harness runs 100 broker disconnects (half of them mid-publish) and 10 restarts; after each event every
  service's `/healthz/ready` is back to 200 within 10 seconds. A reconnect that does not happen within the
  limit fails the run.
- After a 60-second drain, no outbox row of any service is unsent or has a null `published_at` while its
  message was delivered (the harness compares the broker's delivery count with the marked rows).
- Every published message is applied exactly once by its consumer, or sits in the DLQ with its reason.
- The run is repeated three times on a fresh stack; all three pass, or the defect found has a regression
  test that is red before the fix and green after.
- Mutation: stop the relay from marking rows after a publish. The harness comparison goes red.

## Notes

Source: the integration triage after the first compose run and the final coder handoff (the symptoms did
not reproduce on a fresh stack: reconnect within four seconds in the full suite, in the resilience suite
run four times, and through the broker restart). Open question: a defect that needs hours (see the soak
test, MIO-197). Estimate: mostly waiting on long runs.
