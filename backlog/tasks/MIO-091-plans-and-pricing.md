---
id: MIO-091
title: "Plans and pricing: one table, trial, base fee plus usage"
epic: EPIC-09
priority: P0
money_impact: direct
risk_class: budget
status: todo
depends_on: [MIO-080]
size: S
---

## Goal

One source of truth for what operators pay and what they get.

## Scope

- One plans table: plan id, monthly base fee (integer minor units), included usage (monthly active
  players, spins), overage price per unit, feature flags, limits.
- Trial plan (time-limited, capped usage, no card).
- Plans are versioned; a subscription keeps its plan version until changed.

## Acceptance criteria

- There is exactly one definition of plans in code; a test fails if a second plan map is introduced
  (search for plan ids outside the plans module).
- All prices are integers; a float price fails schema validation.
- Changing a plan's price creates a new version and existing subscriptions are unaffected.
