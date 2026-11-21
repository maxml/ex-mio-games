---
id: MIO-023
title: "ERD: ledger and tenants"
epic: EPIC-03
priority: P2
money_impact: none
risk_class: none
status: needs-owner-review
depends_on: [MIO-020, MIO-081, MIO-030]
size: S
---

## Goal

Entity-relationship diagrams for the two data models that are most expensive to change.

## Scope

- `docs/architecture/ledger.erd.json`: accounts, entries, balances, idempotency keys, reservations.
- `docs/architecture/tenants.erd.json`: tenants, users, roles, external player links, integration keys.

## Acceptance criteria

- Both validate and render.
- Table and column names match the TypeORM entities (checked by MIO-026).

## Notes

The owner reviews the archify tasks before work starts.
