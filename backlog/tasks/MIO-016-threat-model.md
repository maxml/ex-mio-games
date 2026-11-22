---
id: MIO-016
title: Threat model
epic: EPIC-02
priority: P1
money_impact: enabler
risk_class: none
status: todo
depends_on: [MIO-010]
size: S
estimate_hours_base: 6
estimate_hours: 8
---

## Goal

Name the attacks that cost money and show which control and which test stops each one.

## Scope

`docs/architecture/threat-model.md`, covering at least: forged or replayed casino events, cross-tenant
access, spin without a credit, client-influenced reward outcome, double redemption, billing webhook
forgery, operator staff escalating to platform admin, leaked integration keys.

## Acceptance criteria

- Each threat row has: actor, entry point, control, test id (from EPIC-14 or elsewhere).
- No row without a control or a stated "accepted risk" with a reason.
