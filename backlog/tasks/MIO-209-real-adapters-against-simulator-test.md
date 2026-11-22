---
id: MIO-209
title: In-process test that each real casino adapter talks to the simulator's server
epic: EPIC-06
priority: P1
money_impact: none
risk_class: none
status: todo
depends_on: [MIO-051, MIO-052, MIO-057]
size: S
estimate_hours_base: 8
estimate_hours: 10
---

## Goal

The two adapters and the simulator agree on paths, signing and bodies by test, not by reading. Today each
side is tested against its own fake.

## Scope

- Start the simulator's server in process on a random port and wire the real adapter A and adapter B to it.
- Cover: a signed deposit event accepted, an issuance accepted and listed by the simulator, a rejected
  signature, a timeout fault and a reject fault.

## Acceptance criteria

- For each casino, the issued reward appears in the simulator's issued list with the amount and the
  idempotency key the adapter sent.
- A wrong signing secret is refused by the simulator, and the adapter reports a refusal (not an unknown
  outcome).
- The simulator's `timeout` fault makes the adapter return an unknown outcome; its `reject` fault makes it
  return a rejection.
- The test runs in the unit suite in under 10 seconds with no compose stack.
- Mutation: change a path or a header name in one adapter. The test for that casino goes red.

## Notes

Source: known gap S-13 and the deliverables audit (the demo script covers it, but it is not a test in any
suite).
