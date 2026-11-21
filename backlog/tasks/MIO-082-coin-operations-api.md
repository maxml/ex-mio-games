---
id: MIO-082
title: "Coin operations API: credit, reserve, capture, release, all idempotent"
epic: EPIC-08
priority: P0
money_impact: direct
risk_class: budget
status: todo
depends_on: [MIO-081, MIO-046]
size: M
---

## Goal

Every coin movement goes through payments and is safe to retry.

## Scope

- Internal endpoints (engagement service token only): `credit`, `reserve`, `capture`, `release`, each with
  a required idempotency key and a reason (`spin`, `redemption`, `adjustment`).
- Same key and same body: returns the stored result. Same key and different body: 409.
- Each operation writes entries, balance change, idempotency record and an outbox `BalanceChanged` in one
  transaction.
- Manual adjustments by operator staff go through the same path with an audit entry.

## Acceptance criteria

- Calling `credit` twice with one key credits once and returns the same response both times.
- `reserve` then `release` returns the balance to its starting value; `release` after `capture` is rejected.
- A transaction that fails after writing entries leaves no entries, no balance change and no outbox row.
