---
id: MIO-096
title: "Entitlements: plan limits checked and counted atomically"
epic: EPIC-09
priority: P1
money_impact: direct
risk_class: budget
status: todo
depends_on: [MIO-091, MIO-093]
blocked_by: ["starter: entitlement evaluator (atomic consume, fail-closed)"]
size: M
---

## Goal

Plans differ in what they allow, and limits hold under concurrency. Required before any plan with a
usage limit is sold; not needed for the first sellable slice, where the trial and the first paid plan
have no enforced cap.

## Scope

- `entitlements.consume(tenant, feature, amount, operationId)`: check and increment in one atomic step
  (conditional update in Postgres, or a Redis script with persistence), returning allowed or denied. The
  key is the business-operation id of the action being limited (MIO-086), so a retried action never
  consumes twice.
- Enforcement lives in the shared evaluator, not in callers: callers receive `allowed` or `denied` with a
  reason, never `null`, and cannot proceed without an explicit `allowed`.
- Feature flags per plan (for example: number of wheels, number of store items, second casino integration).
- Fail-closed: if the entitlement store is unavailable, the limited action is denied and an alert is raised.

## Acceptance criteria

- 100 parallel consumes against a limit of 10 allow exactly 10.
- The same business operation retried (same `operationId`) counts once, also when the retries run in
  parallel.
- With the store down, the call returns `denied` with reason `unavailable`, never `allowed` and never `null`.
- Mutations the reviewer re-applies: split check and increment into two statements (the parallel test
  goes red); return `null` on a store error (the fail-closed test goes red); drop the operation key (the
  retry test goes red).
