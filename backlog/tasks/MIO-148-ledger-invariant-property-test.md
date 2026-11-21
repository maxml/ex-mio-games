---
id: MIO-148
title: Ledger invariant property test
epic: EPIC-14
priority: P1
money_impact: direct
risk_class: budget
status: todo
depends_on: [MIO-082]
size: M
---

## Goal

Prove "no duplicate rewards, no negative balances" for any sequence of operations, not only the ones we thought of.

## Acceptance criteria

- Property-based test (fast-check) generates random concurrent sequences of credit, reserve, capture and
  release with random repeated idempotency keys, runs them against the real payments DB, and checks after
  each run: no balance below zero; for each account, sum of entries equals balance; each idempotency key
  has at most one effect; every transaction's lines sum to zero.
- Runs at least 200 sequences in CI; failing seeds are printed and kept as fixed regression cases.
- Mutation: remove `CHECK (available >= 0)` and the conditional update, then the property fails.
