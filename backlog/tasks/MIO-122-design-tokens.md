---
id: MIO-122
title: Design tokens shared by prototype and web
epic: EPIC-12
priority: P0
money_impact: enabler
risk_class: none
status: todo
depends_on: []
size: S
estimate_hours_base: 8
estimate_hours: 10
---

## Goal

One set of colours, spacing, typography and radii used by the prototype, Storybook and the web app.

## Scope

- Tokens package (`packages/design-tokens`) exporting CSS variables and a Tailwind preset.
- Two themes: player and console; light and dark.

## Acceptance criteria

- A lint rule fails on raw hex colours in `apps/web` and `design/prototype` outside the tokens package.
- Changing one token value changes every story that uses it (visual snapshot diff shows the change).
