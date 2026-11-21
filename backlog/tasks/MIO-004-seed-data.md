---
id: MIO-004
title: "Seed data: platform tenant, two operator tenants, wheel, store"
epic: EPIC-01
priority: P0
money_impact: direct
risk_class: none
status: todo
depends_on: [MIO-030, MIO-060, MIO-062, MIO-065]
size: S
---

## Goal

The demo starts with realistic data, so a prospect sees a working product in the first minute.

## Scope

- Platform tenant with one platform admin.
- Two operator tenants, one connected to Casino A and one to Casino B, each with an operator admin,
  integration keys, a deposit rule, a weighted reward table and a Bonus Store catalog.
- Idempotent seed command (`pnpm seed`), run automatically by compose in the demo profile.

## Acceptance criteria

- Running the seed twice leaves the same row counts as running it once.
- After seeding, `GET /v1/store/items` for each operator returns its own catalog and never the other's.
- The seed contains no real personal data.
