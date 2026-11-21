---
id: MIO-093
title: Checkout and subscription lifecycle
epic: EPIC-09
priority: P0
money_impact: direct
risk_class: budget
status: todo
depends_on: [MIO-090, MIO-091]
size: M
---

## Goal

Operators pay, upgrade, downgrade and cancel; the tenant's status follows.

## Scope

- Checkout through the provider; subscription states `trialing`, `active`, `past_due`, `canceled`.
- Upgrade takes effect at once; downgrade at period end; cancellation keeps access until period end.
- `past_due` beyond a grace period suspends the tenant (engagement stops granting spins; data kept).

## Acceptance criteria

- The subscription becomes `active` only from a verified provider webhook, never from the browser redirect.
- A suspended tenant's ingestion returns 402 and grants nothing; reactivation resumes without data loss.
- `billing.plan_activated` and `billing.subscription_changed` are emitted on the matching transitions.
