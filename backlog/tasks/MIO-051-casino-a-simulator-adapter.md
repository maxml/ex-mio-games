---
id: MIO-051
title: "Casino A: simulator and adapter"
epic: EPIC-06
priority: P0
money_impact: direct
risk_class: guard
status: todo
depends_on: [MIO-050, MIO-057]
size: M
---

## Goal

The first simulated casino platform, as its own container, and its adapter.

## Scope

- `casino-a-sim`: sends signed deposit webhooks in schema A (for example `{eventId, playerId,
  amount: {value, currency}, status: "SUCCESS", ts}` with header `X-A-Signature`), and exposes reward API A
  (synchronous `POST /bonuses` returning the final state). Recovery mode: native lookup by our key
  (`GET /bonuses?idempotencyKey=`).
- Simulator UI or CLI to trigger a deposit for a player; it records issued rewards for inspection.
- Adapter A in the integrations module.

## Acceptance criteria

- A deposit from `casino-a-sim` results in one canonical `deposit.succeeded` event.
- A reward issued through adapter A is visible in the simulator's issued list.
- Adapter A passes the shared adapter contract suite (MIO-057).
