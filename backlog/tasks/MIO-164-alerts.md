---
id: MIO-164
title: 'Alerts: DLQ not empty, reconciliation drift, issuance failure rate'
epic: EPIC-15
priority: P2
money_impact: direct
risk_class: none
status: todo
depends_on: [MIO-160, MIO-084, MIO-068]
size: S
estimate_hours_base: 8
estimate_hours: 10
---

## Goal

Money problems page someone before an operator notices.

## Scope

Alert rules in Varta: DLQ depth above zero for 5 minutes; any reconciliation mismatch; reconciliation not
run in the last 2 hours; issuance failure rate above a threshold per tenant; webhook rejection spike per tenant.

## Acceptance criteria

- Each rule is defined as code and has a test that feeds a sample metric series and expects it to fire.
- "Reconciliation did not run" fires when the job is stopped (the absence of a run is an alert, not silence).
