---
id: MIO-082
title: "Coin operations API: credit, hold, capture, release, refund, all idempotent"
epic: EPIC-08
priority: P0
money_impact: direct
risk_class: budget
status: todo
depends_on: [MIO-081, MIO-046, MIO-086]
size: M
---

## Goal

Every coin movement goes through payments, is safe to retry, and is safe under concurrency.

## Scope

- Internal commands (engagement service token only, also accepted from the outbox through the inbox):
  `credit`, `hold`, `capture`, `release`, `refund`, each with the business-operation id from MIO-086 as
  its idempotency key and a reason (`spin`, `redemption`, `adjustment`). Hold semantics follow the hold
  table in MIO-066.
- Idempotency follows MIO-086: same scope and same request hash returns the stored result; same scope
  and a different hash returns 422 `idempotency_key_reused`.
- The amount always comes from an authoritative source: the spin's recorded segment for `credit`, the
  redemption's price snapshot for `hold`; a player-facing endpoint never accepts an amount or a balance.
- Each operation writes the journal transaction, its legs, the balance change, the idempotency record and
  an outbox `BalanceChanged` in one database transaction.
- Manual adjustments by operator staff go through the same path with an audit entry (MIO-161).
- No public (player or operator) route can call `credit`; the route table test fails if one is added.

## Acceptance criteria

- Calling `credit` twice with one key credits once and returns the same response both times.
- `hold` then `release` returns the available balance to its starting value; `release` after `capture`
  is rejected; `capture` after `release` is rejected.
- **Rollback together:** a failure injected after the journal insert, after the balance update, and after
  the outbox insert (three tests) leaves no transaction, no entries, no balance change, no idempotency
  record and no outbox row.
- **Spend concurrency:** 50 parallel `hold` commands with different keys against a balance that covers 7
  of them: exactly 7 succeed, 43 return `insufficient_funds`, available never below zero.
- **Mixed concurrency:** 100 parallel credits and holds on one account: final available plus held equals
  the starting value plus credits minus successful holds (conservation), with no lost update.
- A player token calling any command gets 403; an operator token calling `credit` gets 403.
- Mutations the reviewer re-applies: write the balance from a value read before the transaction (the
  mixed-concurrency test goes red); split the outbox insert into a second transaction (the rollback test
  goes red).
