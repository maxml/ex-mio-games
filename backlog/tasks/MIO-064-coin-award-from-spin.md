---
id: MIO-064
title: Coin reward from a spin recorded through payments
epic: EPIC-07
priority: P0
money_impact: direct
risk_class: budget
status: todo
depends_on: [MIO-063, MIO-082]
size: S
estimate_hours_base: 8
estimate_hours: 10
---

## Goal

Assignment step 5: a coin reward is recorded in the virtual currency ledger.

## Scope

- `SpinCompleted` with a coin segment leads to a payments credit with idempotency key `spin:{spin_id}`.
- Engagement never writes balances; it only asks payments.
- The player sees the new balance (websocket `balance.changed`).

## Acceptance criteria

- Redelivering `SpinCompleted` five times credits the coins once.
- If payments is down, the credit is retried from the outbox and lands once payments is back.
- A `nothing` segment creates no ledger entry.
