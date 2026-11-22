---
id: MIO-099
title: "Revenue view for the platform admin: MRR and usage per operator"
epic: EPIC-09
priority: P1
money_impact: direct
risk_class: ownership
status: todo
depends_on: [MIO-093, MIO-095]
size: S
estimate_hours_base: 6
estimate_hours: 8
---

## Goal

MIO staff see whether the business makes money and which operators drive it.

## Scope

- API and console page: MRR, number of paying operators, trials, churned operators, usage and overage per
  operator, failed payments.
- Platform role only.

## Acceptance criteria

- MRR equals the sum of active subscriptions' monthly fees in a seeded test.
- An operator token gets 403 on these endpoints.
