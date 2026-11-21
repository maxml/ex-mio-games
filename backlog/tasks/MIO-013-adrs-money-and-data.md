---
id: MIO-013
title: ADRs for money and data one-way doors
epic: EPIC-02
priority: P1
money_impact: enabler
risk_class: none
status: todo
depends_on: []
size: M
---

## Goal

Write down the decisions that are very expensive to change later, and only those.

## Scope

One ADR each in `docs/adrs/`:

- Tenancy model: platform admin as a tenant, user key `(tenant_id, user_id)`, RLS plus request context.
- Coin ledger: Postgres tables in payments, append-only entries, integer amounts, no negative balance,
  operations only through payments, balance readable everywhere.
- Redemption as a saga with compensation; timeout is not failure.
- Wheel fairness: server-side deterministic outcome, versioned tables.
- Event envelope and versioning (with MIO-015).
- Analytics event taxonomy (with MIO-100).

## Acceptance criteria

- Each ADR names the alternatives considered and the reason they lost.
- Each ADR links the test that guards its main invariant (or the task that will add it).
