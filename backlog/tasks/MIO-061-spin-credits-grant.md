---
id: MIO-061
title: Spin credits granted from `DepositConfirmed`, once per event
epic: EPIC-07
priority: P0
money_impact: direct
risk_class: concurrency
status: todo
depends_on: [MIO-056, MIO-060]
size: M
estimate_hours_base: 16
estimate_hours: 20
---

## Goal

Assignment step 3: the player receives one Wheel of Fortune spin.

## Scope

- Consumer of `DepositConfirmed` runs the rules and inserts spin credit rows
  `(tenant_id, id, user_id, wheel_id, source_event_id, status: available)`.
- `UNIQUE (tenant_id, source_event_id, rule_id, seq)` so redelivery cannot add credits.
- Publishes `SpinGranted` through the outbox; the widget is notified over the websocket.

## Acceptance criteria

- One deposit event delivered three times creates exactly N credits.
- A credit belongs to the player resolved by the identity link (MIO-044), never to a player id from the
  event body without mapping.
- `GET /v1/me/spins` shows the new credit; the websocket pushes `spin.granted`.
