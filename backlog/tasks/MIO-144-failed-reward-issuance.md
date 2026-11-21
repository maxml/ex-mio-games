---
id: MIO-144
title: "Part C: failed reward issuance and compensation"
epic: EPIC-14
priority: P1
money_impact: direct
risk_class: budget
status: todo
depends_on: [MIO-066]
size: S
---

## Goal

Prove that a final casino rejection returns the coins exactly once.

## Acceptance criteria

- Simulator `reject`: redemption ends `FAILED` then `REFUNDED`; balance equals the balance before the
  redemption; no reward in the simulator.
- The `release` command delivered 3 times: one refund.
- Crash between `FAILED` and the refund: after restart the refund happens once.
- Mutation: skip the compensation step, then the balance assertion goes red; remove the idempotency key
  on release, then the redelivery test goes red.
