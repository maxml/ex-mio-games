---
id: MIO-142
title: "Part C: duplicate redemption requests"
epic: EPIC-14
priority: P1
money_impact: direct
risk_class: locks
status: todo
depends_on: [MIO-066]
size: S
---

## Goal

Prove that retries and double clicks never redeem twice or spend coins twice.

## Acceptance criteria

- The same `Idempotency-Key` sent 10 times in parallel: one redemption, one reservation, one casino call,
  all responses identical.
- Same key with a different item: 409, nothing created.
- Two different keys in parallel with a balance that covers only one: one succeeds, one gets 409
  `insufficient_funds`; the balance never goes below zero.
- Adapter receives the same idempotency key on every retry of one redemption (simulator records keys).
- Mutation: remove the idempotency check, then the first test goes red; remove the conditional debit,
  then the third test goes red.
