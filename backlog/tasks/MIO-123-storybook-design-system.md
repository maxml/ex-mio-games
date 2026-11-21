---
id: MIO-123
title: Storybook design system; screens built only from its components
epic: EPIC-12
priority: P1
money_impact: direct
risk_class: none
status: todo
depends_on: [MIO-122]
blocked_by: ["starter: Storybook design system"]
size: L
---

## Goal

Design drives money, so the whole frontend is made of Storybook components and design changes in one place.

## Scope

- `packages/ui` with Storybook: foundations (tokens), primitives, composite components (wheel, balance
  chip, store card, status badge, rule editor, weight table, plan card, event log), and page templates.
- Each component has stories for its states (loading, empty, error, success) and docs.
- `apps/web` imports UI only from `packages/ui`.

## Acceptance criteria

- A lint boundary fails if `apps/web` renders raw HTML elements for anything except layout wrappers
  allowed by a short list.
- Every exported component in `packages/ui` has at least one story (test that compares exports with stories).
- Storybook builds in CI and is published as a static artifact.
