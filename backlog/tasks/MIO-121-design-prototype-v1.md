---
id: MIO-121
title: Design prototype v1 in `design/prototype/`
epic: EPIC-12
priority: P0
money_impact: direct
risk_class: none
status: todo
depends_on: []
size: L
---

## Goal

A clickable prototype of the main screens, built before the product code, to sell the idea and to fix the
flows before they are expensive to change.

## Scope

- Player: wheel widget inside a mock casino page, spin animation and result, coin balance, Bonus Store,
  reward status, history.
- Operator: sign-up and onboarding steps, integration keys, test event log, rules, wheel table editor with
  probabilities, store catalog, billing and plan choice, reports.
- Platform admin: tenants, revenue and MRR, usage per operator.
- Runs with mock data only (`pnpm --filter prototype dev`); no backend needed.
- Uses the design tokens (MIO-122) and a placeholder theme until MIO-120 is unblocked.

## Acceptance criteria

- Every screen listed above is reachable by clicking from a start page.
- The operator onboarding path and the player deposit-to-reward path can be walked end to end.
- The prototype builds in CI and is published as a static artifact for review.
- Elements are written so they can move into Storybook later without a rewrite.
