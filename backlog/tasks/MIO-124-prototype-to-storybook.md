---
id: MIO-124
title: Move prototype elements into Storybook
epic: EPIC-12
priority: P1
money_impact: enabler
risk_class: none
status: todo
depends_on: [MIO-121, MIO-123]
size: M
---

## Goal

The prototype's elements become the product's components; nothing is designed twice.

## Scope

Move each reusable element from `design/prototype/` into `packages/ui` with stories; the prototype then
imports from `packages/ui`.

## Acceptance criteria

- After the move, `design/prototype/` contains only screens and mock data, no component definitions
  (check by script).
- Visual snapshots of the prototype screens before and after the move match.
