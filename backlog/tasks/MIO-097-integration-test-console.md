---
id: MIO-097
title: "Integration test console: send a test event and see it arrive"
epic: EPIC-09
priority: P0
money_impact: direct
risk_class: none
status: todo
depends_on: [MIO-051, MIO-054, MIO-110]
size: M
---

## Goal

Shorten time to first value: during onboarding the operator sees their own integration work in seconds.

## Scope

- Operator console page with a "send test deposit" button that drives the sandbox simulator for the
  operator's casino type, using the operator's real keys.
- Live event log (websocket) showing each event: received, validated, deduplicated, spins granted, or
  rejected with the reason.
- A copy-paste snippet showing the exact payload and signature for the operator's developers.

## Acceptance criteria

- The first accepted event emits `integration.first_event_received` once per tenant.
- A deliberately bad signature shows up in the log as rejected with reason `signature`.
- Test events are marked as test and excluded from metering.
