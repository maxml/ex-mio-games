---
id: MIO-140
title: "Part C: duplicate deposit events"
epic: EPIC-14
priority: P1
money_impact: direct
risk_class: admission
status: todo
depends_on: [MIO-055, MIO-061]
size: S
---

## Goal

Prove that a deposit event delivered more than once grants spins once.

## Acceptance criteria

- Same webhook delivered 5 times sequentially, for each casino: one inbound row, N credits (per the rule),
  every response 200 with the same body.
- Same webhook delivered 20 times in parallel: same result.
- The broker redelivers `DepositConfirmed` 3 times: same result (inbox).
- Same `external_event_id` in two tenants: two independent events.
- Mutation: drop the unique constraint, then the parallel test goes red; drop the inbox check, then the
  redelivery test goes red.
