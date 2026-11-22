---
id: MIO-142
title: 'Part C: duplicate redemption requests'
epic: EPIC-14
priority: P1
money_impact: direct
risk_class: locks
status: todo
depends_on: [MIO-066]
size: S
estimate_hours_base: 8
estimate_hours: 10
---

## Goal

Prove that retries and double clicks never redeem twice or spend coins twice.

## Acceptance criteria

- The same `Idempotency-Key` sent 10 times in parallel: one redemption, one hold, one casino call; every
  response is either the stored result or 409 `idempotency_in_progress`, and all completed responses are
  identical.
- Same key with a different item: 422 `idempotency_key_reused`, nothing created.
- Same key and item replayed after the HTTP idempotency record was purged: the existing redemption is
  returned; no second hold and no second casino call (durable `operation_id`, MIO-086).
- Same key used by another player of the same tenant: a separate redemption for that player, and the
  first player's response is never returned to them.
- Two different keys in parallel with a balance that covers only one: one succeeds, one gets 409
  `insufficient_funds`; the balance never goes below zero.
- Adapter receives the same idempotency key on every retry of one redemption (simulator records keys).
- Mutation: remove the idempotency check, then the first test goes red; remove the conditional debit,
  then the third test goes red.
