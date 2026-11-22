---
id: MIO-106
title: One analytics panel in Varta, with a reader test
epic: EPIC-10
priority: P1
money_impact: direct
risk_class: none
status: todo
depends_on: [MIO-102, MIO-103, MIO-104]
blocked_by: ['Varta: product events stream with long retention and a generated analytics dashboard']
size: M
estimate_hours_base: 16
estimate_hours: 20
---

## Goal

One panel for all analytics: operator funnel, player funnel, DAU and WAU, retention cohorts, usage per
tenant, MRR.

## Scope

- Declare the product's funnels in Varta's inventory so Varta generates the analytics dashboard next to
  the operations dashboard.
- Optional local `analytics` compose profile that runs Varta's collector and storage to see the panel
  without any account.

## Acceptance criteria

- Reader test: a sample event emitted by the product lands in the product events stream and a dashboard
  panel query returns it.
- The operator funnel panel shows the counts produced by the onboarding end-to-end test.

## Notes

The Varta-side changes (product events stream, retention, generated analytics dashboard) are requested
from Varta; this task only declares and verifies.
