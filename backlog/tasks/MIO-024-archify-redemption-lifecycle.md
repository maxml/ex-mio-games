---
id: MIO-024
title: "Lifecycle diagram: redemption status"
epic: EPIC-03
priority: P2
money_impact: none
risk_class: none
status: needs-owner-review
depends_on: [MIO-020, MIO-067]
size: S
---

## Goal

One picture of every redemption status and every allowed transition.

## Scope

`docs/architecture/redemption.lifecycle.json`: `REQUESTED → RESERVED → ISSUING → ISSUED`, `ISSUING →
UNKNOWN → (ISSUED | ISSUING | FAILED)`, `FAILED → REFUNDED`, with the trigger for each transition.

## Acceptance criteria

- Validates and renders.
- The set of states and transitions equals the state machine in code (a test exports the code's
  transition table and compares it with the IR).

## Notes

The owner reviews the archify tasks before work starts.
