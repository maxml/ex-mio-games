---
id: MIO-096
title: "Entitlements: plan limits checked and counted atomically"
epic: EPIC-09
priority: P0
money_impact: direct
risk_class: budget
status: todo
depends_on: [MIO-091, MIO-093]
size: M
---

## Goal

Plans differ in what they allow, and limits hold under concurrency.

## Scope

- `entitlements.consume(tenant, feature, amount, idempotencyKey)`: check and increment in one atomic step
  (conditional update or Redis script with persistence), returning allowed or denied.
- Feature flags per plan (for example: number of wheels, number of store items, second casino integration).
- Fail-closed: if the entitlement store is unavailable, the limited action is denied and an alert is raised.

## Acceptance criteria

- 100 parallel consumes against a limit of 10 allow exactly 10.
- The same idempotency key consumed twice counts once.
- With the store down, the call returns `denied` with reason `unavailable`, never `allowed` and never `null`.
