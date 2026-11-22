---
id: MIO-097
title: 'Integration test console: send a test event and see it arrive'
epic: EPIC-09
priority: P1
money_impact: direct
risk_class: none
status: todo
depends_on: [MIO-051, MIO-054, MIO-092, MIO-110]
size: M
---

## Goal

Shorten time to first value: during onboarding the operator sees their own integration work in seconds.

## Scope

- Operator console page with a "send test deposit" button that drives the sandbox simulator for the
  operator's casino type. Sandbox events follow the sandbox boundary defined in MIO-092 (sandbox keys,
  sandbox players, sandbox ledger accounts, rewards only to the simulator).
- Live event log (websocket) showing each event: received, validated, deduplicated, spins granted, or
  rejected with the reason.
- A copy-paste snippet showing the exact payload and signature for the operator's developers.

## Acceptance criteria

- The log shows the event that produced `integration.first_event_received` (emitted by ingestion, see
  MIO-092) as the tenant's first accepted event.
- A deliberately bad signature shows up in the log as rejected with reason `signature`.
- Sandbox events are shown with a sandbox badge; a production event never is.
