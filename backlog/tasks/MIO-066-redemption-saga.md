---
id: MIO-066
title: "Redemption saga: reserve, issue, settle or compensate"
epic: EPIC-07
priority: P0
money_impact: direct
risk_class: locks
status: todo
depends_on: [MIO-065, MIO-082, MIO-051, MIO-052]
blocked_by: ["starter: idempotency package"]
size: L
---

## Goal

Assignment steps 6 and 7: the player redeems coins for a store item, and MIO requests issuance through
the casino adapter, with no duplicate reward and no lost coins.

## Scope

- `POST /v1/redemptions` with required `Idempotency-Key` and `item_id`.
- Saga: create redemption `REQUESTED` → payments reserves coins (idempotency key `redeem:{id}`) →
  `RESERVED` → adapter `issueReward` with idempotency key `redeem:{id}` → `ISSUED` and payments captures,
  or final rejection → `FAILED` and payments releases the reservation → `REFUNDED`.
- Stock and per-player limits checked atomically with the reservation.
- Every step is a durable state change with an outbox message; a crash resumes from the last state.

## Acceptance criteria

- Insufficient balance: 409, no reservation, no casino call.
- Casino accepts: one `ISSUED` redemption, coins captured, one reward in the simulator.
- Casino rejects: `FAILED` then `REFUNDED`, balance back to the original value, no reward in the simulator.
- Crash after the casino call but before recording the result: after restart the status is reconciled
  from the casino and the reward is not issued twice.
