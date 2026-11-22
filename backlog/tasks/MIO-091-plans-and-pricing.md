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
estimate_hours_base: 8
estimate_hours: 10
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
- **Checkout and fulfilment conformance:** for every plan version, the price sent to the provider at
  checkout and the plan, limits and features granted when the webhook activates the subscription are read
  from the same catalog entry; a test buys each plan with the `fake` provider and compares both sides.
- The browser never supplies a price or a plan's contents, only a plan id; a checkout request with an
  amount field is rejected.
- All prices are integers; a float, negative or overflowing price fails schema validation.
- Changing a plan's price creates a new version and existing subscriptions are unaffected.
