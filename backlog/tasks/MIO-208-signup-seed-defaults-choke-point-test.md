---
id: MIO-208
title: Test that tenant creation seeds the default rule and wheel through the real event
epic: EPIC-07
priority: P1
money_impact: direct
risk_class: none
status: todo
depends_on: [MIO-060, MIO-061]
size: S
estimate_hours_base: 4
estimate_hours: 5
---

## Goal

A new operator gets a working default deposit rule and wheel without any manual step. The wiring is the one
place where deleting a line turns no test red.

## Scope

- A compose-level test: create a tenant through the identity signup, wait for `identity.tenant.created` to
  reach engagement, then deposit and spin. No SQL insert of a rule or a spin credit.

## Acceptance criteria

- After signup, the tenant's default rule and wheel exist within 10 seconds, read through the operator
  routes.
- A first deposit through the sandbox casino grants one spin credit and a spin returns a segment, with
  nothing seeded by SQL.
- Replaying the same `tenant.created` event creates no second rule or wheel.
- Mutation: remove the `seedDefaults` call in the engagement event handler. The test goes red.

## Notes

Source: the deliverables audit (the wiring that calls `seedDefaults` on `identity.tenant.created` is not
covered; every compose spin test inserts its credit by SQL).
