---
id: MIO-065
title: Bonus Store catalog
epic: EPIC-07
priority: P0
money_impact: direct
risk_class: budget
status: todo
depends_on: [MIO-032, MIO-045]
size: S
estimate_hours_base: 8
estimate_hours: 10
---

## Goal

Players have something to spend coins on; operators decide what.

## Scope

- Item: name, description, image, price in coins (integer), casino reward mapping (reward type and
  parameters in canonical form, translated by the adapter), stock (optional), per-player limit, active flag.
- Operator API and console to manage items; player API to list active items.

## Acceptance criteria

- An item with a non-positive or non-integer price is rejected with 422.
- Deactivated items disappear from the player list but existing redemptions keep their status.
- A player of tenant A never sees tenant B's items.
- Stock and per-player limits are counters in the engagement database, changed only by conditional
  updates; stock never goes below zero under 50
  parallel reservations.
- Only operator `owner` and `admin` can create or edit items (`can()` check, MIO-045); an `analyst` gets 403.
