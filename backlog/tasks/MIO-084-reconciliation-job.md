---
id: MIO-084
title: "Reconciliation job: entries sum equals balance"
epic: EPIC-08
priority: P1
money_impact: direct
risk_class: budget
status: todo
depends_on: [MIO-081]
size: S
---

## Goal

If the materialised balance ever drifts from the ledger, we know within an hour.

## Scope

- Scheduled job per tenant: for every account, `sum(entries) = balance`; and reserved coins match open
  redemptions in engagement.
- Writes a run record (start, end, accounts checked, mismatches) and emits a metric and an alert on mismatch.
- Never fixes data automatically.

## Acceptance criteria

- A test that corrupts one balance row directly in the DB makes the next run report exactly that account.
- The last run's time and result are visible on the platform admin console and through an API.
- A run that fails to complete is reported as a failure, not as "no mismatches".
