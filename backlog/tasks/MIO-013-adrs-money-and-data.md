---
id: MIO-013
title: ADRs for money and data one-way doors
epic: EPIC-02
priority: P0
money_impact: enabler
risk_class: none
status: todo
depends_on: []
size: M
---

## Goal

Write down the decisions that are very expensive to change later, and only those, before the schemas
and services that embody them are built. This is a contract task: no code, and every data-owning task
depends on it.

## Scope

One ADR each in `docs/adrs/`:

- Tenancy model: platform admin as a tenant, user key `(tenant_id, user_id)`, RLS plus request context.
- Coin ledger: Postgres tables in payments, balanced journal transactions, append-only entries, integer
  amounts, no negative balance, operations only through payments, balance readable everywhere (MIO-081).
- Redemption as a saga with compensation; timeout is not failure; two reservations in two databases
  (MIO-066).
- Idempotency and durable business-operation ids (MIO-086).
- Personal data and erasure: personal data only in identity; every other store uses opaque ids; erasure
  removes the identity profile and link and never edits ledger, audit or analytics rows (MIO-107).
- Analytics delivery guarantee: business funnel events go through the transactional outbox (at least
  once, deduplicated by `event_id` when read); behavioural events are best effort (MIO-101).
- Tenant status ownership: identity owns `active` and `suspended`; payments reports billing state;
  engagement keeps a read-only projection (MIO-093).
- Wheel fairness: server-side deterministic outcome, versioned tables.
- Event envelope and versioning (with MIO-015).
- Analytics event taxonomy (with MIO-100).

## Acceptance criteria

- Each ADR names the alternatives considered and the reason they lost.
- Each ADR links the test that guards its main invariant (or the task that will add it).
