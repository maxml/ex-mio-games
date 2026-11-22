---
id: MIO-141
title: 'Part C: concurrent spin requests'
epic: EPIC-14
priority: P1
money_impact: direct
risk_class: concurrency
status: todo
depends_on: [MIO-063]
size: S
---

## Goal

Prove that one spin credit gives exactly one spin, however many requests race for it.

## Acceptance criteria

- 50 parallel `POST /v1/spins` with different idempotency keys and one available credit: exactly one 201,
  the rest 409; one spin row; at most one coin credit.
- 50 parallel requests with the same idempotency key: all return the same spin; one credit consumed.
- Player with 3 credits and 50 parallel requests: exactly 3 spins.
- Mutation: replace the conditional `UPDATE … WHERE status='available'` with read-then-write, then the
  first test goes red.
