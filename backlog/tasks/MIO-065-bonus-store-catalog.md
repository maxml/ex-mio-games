---
id: MIO-065
title: Bonus Store catalog
epic: EPIC-07
priority: P0
money_impact: direct
risk_class: none
status: todo
depends_on: []
size: S
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
