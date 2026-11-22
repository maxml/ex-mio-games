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
estimate_hours_base: 8
estimate_hours: 10
---

## Goal

Assignment step 8: the reward's final status is tracked and exposed through an API.

## Scope

- State machine exactly as the redemption transition table in MIO-066: `REQUESTED`, `RESERVED`,
  `REJECTED_FUNDS`, `ISSUING`, `UNKNOWN`, `ISSUED`, `COMPLETED`, `REJECTED`, `RELEASED`, `REFUNDED`,
  `NEEDS_REVIEW`; illegal transitions throw.
- Final states for the API: `COMPLETED` (reward issued, coins spent), `RELEASED` and `REJECTED_FUNDS`
  (no reward, no coins spent), `REFUNDED` (reward revoked, coins returned). `NEEDS_REVIEW` is shown to the
  player as "processing" and to the operator with the reason.
- `GET /v1/redemptions/{id}` (player: own only; operator: own tenant) with status, timestamps, attempt
  count, casino reference and failure reason.
- `GET /v1/redemptions?status=` for the operator console.
- Status changes pushed over the websocket once MIO-112 is in place; until then the widget reads this API.

## Acceptance criteria

- Every transition not in the table is rejected by a unit test that tries all pairs.
- The code's transition table is exported and compared with the table in MIO-066 (and later with the
  lifecycle diagram); a difference fails the test.
- A player reading another player's redemption gets 404, also when the id is guessed from a sequence
  (ids are UUIDv7 and the lookup is `(tenant_id, user_id, id)`).
- The status history (each transition with time and cause) is returned and is append-only.
- Reader test: the operator list filtered by `NEEDS_REVIEW` returns a redemption put there by the
  late-success test in MIO-066, with the reason described correctly.
