---
id: MIO-104
title: "Billing events: subscription changes and daily MRR snapshot"
epic: EPIC-10
priority: P1
money_impact: direct
risk_class: none
status: todo
depends_on: [MIO-101, MIO-093]
size: S
---

## Goal

Revenue charts in the analytics panel without reading the payments database.

## Scope

- `billing.subscription_changed` with `from_plan`, `to_plan`, `mrr_minor`.
- `billing.mrr_snapshot` once per tenant per day from a scheduled job.

## Acceptance criteria

- The daily job, run twice on the same day, results in one counted snapshot per tenant (deterministic
  `event_id`, business-event delivery and read-side dedupe as defined in MIO-101).
- `billing.subscription_changed` is written in the same transaction as the subscription change; a
  rolled-back change emits nothing.
- Sum of snapshot `mrr_minor` equals MIO-099's MRR for the same day in a seeded test.
- The job's last run time and result are recorded and visible to platform staff.
