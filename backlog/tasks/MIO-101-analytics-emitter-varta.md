---
id: MIO-101
title: Analytics emitter under the Varta contract
epic: EPIC-10
priority: P0
money_impact: enabler
risk_class: none
status: todo
depends_on: [MIO-100]
blocked_by: ["starter: analytics emitter"]
size: S
---

## Goal

Every service can emit product events with one call, and the product does not break when Varta is down.

## Scope

- `track(event)` with the typed registry, validation and a consent check.
- Default sink: one structured JSON line on stdout through the existing logger, as Varta's telemetry
  contract expects; Varta collects it from there.
- `memory` sink for tests.
- Business events (deposit, redemption, plan change) are `essential`; behavioural events need consent.

## Acceptance criteria

- With the memory sink, a test asserts the exact event emitted by a use case.
- An event with `consent: "analytics"` for an actor who has not opted in is dropped and counted.
- Stopping Varta has no effect on the product (no network call from the emitter).
- No email, IP address or payment data can appear in an event (validation test with such fields).
