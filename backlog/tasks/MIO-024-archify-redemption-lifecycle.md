---
id: MIO-024
title: 'Lifecycle diagram: redemption status'
epic: EPIC-03
priority: P2
money_impact: none
risk_class: none
status: needs-owner-review
depends_on: [MIO-020, MIO-067]
size: S
estimate_hours_base: 5
estimate_hours: 6
---

## Goal

One picture of every redemption status and every allowed transition.

## Scope

`docs/architecture/redemption.lifecycle.json`: every state and transition of the redemption table in
MIO-066 (`REQUESTED → RESERVED → ISSUING → ISSUED → COMPLETED`, `ISSUING → UNKNOWN → (ISSUED | ISSUING |
REJECTED | NEEDS_REVIEW)`, `REJECTED → RELEASED`, `COMPLETED → REFUNDED`, `REQUESTED → REJECTED_FUNDS`,
late responses to `NEEDS_REVIEW`), with the trigger for each transition, plus the payments hold lifecycle.

## Acceptance criteria

- Validates and renders.
- The set of states and transitions equals the state machine in code (a test exports the code's
  transition table and compares it with the IR).

## Notes

The owner reviews the archify tasks before work starts.
