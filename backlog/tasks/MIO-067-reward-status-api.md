---
id: MIO-067
title: Reward status tracking and status API
epic: EPIC-07
priority: P0
money_impact: direct
risk_class: ownership
status: todo
depends_on: [MIO-066]
size: S
---

## Goal

Assignment step 8: the reward's final status is tracked and exposed through an API.

## Scope

- State machine: `REQUESTED`, `RESERVED`, `ISSUING`, `UNKNOWN`, `ISSUED`, `FAILED`, `REFUNDED`, with an
  explicit transition table; illegal transitions throw.
- `GET /v1/redemptions/{id}` (player: own only; operator: own tenant) with status, timestamps, attempt
  count, casino reference and failure reason.
- `GET /v1/redemptions?status=` for the operator console.
- Status changes pushed over the websocket.

## Acceptance criteria

- Every transition not in the table is rejected by a unit test that tries all pairs.
- A player reading another player's redemption gets 404.
- The status history (each transition with time and cause) is returned and is append-only.
