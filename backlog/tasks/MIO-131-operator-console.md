---
id: MIO-131
title: 'Operator console: onboarding, keys, rules, wheel tables, store, billing'
epic: EPIC-13
priority: P1
money_impact: direct
risk_class: ownership
status: todo
depends_on: [MIO-123, MIO-092, MIO-060, MIO-062, MIO-065, MIO-098]
size: L
estimate_hours_base: 48
estimate_hours: 58
---

## Goal

Operators onboard themselves, pay, and configure the product (assignment Part A: admin configuration).

## Scope

- Onboarding wizard (MIO-092), integration keys and the test event log (MIO-097).
- Rules editor, wheel table editor with live probability and expected value, store catalog.
- Redemptions list with status and failure reasons; player lookup with balance and history.
- Billing: plan, usage, invoices (MIO-098). Staff management with roles.

## Acceptance criteria

- Playwright end-to-end: sign up, get keys, send a test event, publish a rule and a table, add a store
  item, choose a plan and pay with the fake provider.
- An `analyst` sees configuration read-only (buttons hidden and API returns 403).
