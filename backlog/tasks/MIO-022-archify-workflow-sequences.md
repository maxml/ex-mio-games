---
id: MIO-022
title: "Workflow and sequence diagrams: the 8-step flow and the redemption saga"
epic: EPIC-03
priority: P2
money_impact: none
risk_class: none
status: needs-owner-review
depends_on: [MIO-020]
size: M
estimate_hours_base: 12
estimate_hours: 15
---

## Goal

Show how one deposit becomes an issued reward, and what happens on timeout and failure.

## Scope

- `docs/architecture/deposit-to-reward.sequence.json`: the 8 assignment steps across casino simulator,
  engagement, payments, broker and web.
- `docs/architecture/redemption-saga.sequence.json`: reserve, issue, timeout, status query, retry,
  issued or failed, compensation.

## Acceptance criteria

- Both validate and render.
- Every message name in the diagrams matches an event or endpoint in `packages/contracts` (checked in review; the automated drift check is a later task).

## Notes

The owner reviews the archify tasks before work starts.
