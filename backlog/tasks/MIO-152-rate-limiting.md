---
id: MIO-152
title: Rate limiting on ingest, spin and redeem
epic: EPIC-14
priority: P2
money_impact: enabler
risk_class: guard
status: todo
depends_on: [MIO-054, MIO-063, MIO-066]
size: S
---

## Goal

Abuse and runaway clients cannot overload the money paths.

## Scope

Redis-backed limits per tenant for ingestion and per player for spin and redeem; limits configurable per plan.

## Acceptance criteria

- Exceeding the limit returns 429 with `Retry-After`.
- One tenant hitting its limit does not affect another tenant's requests (test).
- With Redis unavailable, ingestion keeps working (fail-open for ingest only, documented); spin and redeem
  keep working because their safety comes from the database, not the limiter.
