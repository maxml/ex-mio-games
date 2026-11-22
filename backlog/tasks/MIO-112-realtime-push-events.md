---
id: MIO-112
title: "Push events with server-side catch-up: spin granted, balance changed, redemption status changed"
epic: EPIC-11
priority: P1
money_impact: direct
risk_class: isolation
status: todo
depends_on: [MIO-110, MIO-061, MIO-083, MIO-067, MIO-134]
blocked_by: ["starter: resilient websocket"]
size: M
---

## Goal

The player sees the result of a deposit, a spin and a redemption without reloading, and nothing is
missed when the socket drops.

## Scope

- The realtime server consumes `SpinGranted`, `BalanceChanged`, `RedemptionStatusChanged` from RabbitMQ
  and pushes to the owner's channel; the operator channel gets integration log events (MIO-097).
- **Catch-up journal (server side).** If the starter's resilient websocket provides a journal, this task
  uses it and runs its conformance test; otherwise the product implements the same contract:
  - owner: the realtime server; one journal per channel (`tenant:{tid}:user:{uid}`, `tenant:{tid}:ops`)
    in Redis streams with persistence (AOF), consistent with the owner's "Redis survives restarts" rule;
  - sequence: the stream entry id assigned atomically by Redis on append; the message pushed carries it;
  - the consumer appends to the journal and acknowledges the RabbitMQ message only after the append;
    a duplicate domain event (same `event_id`) is appended once;
  - retention: 24 hours or 1,000 entries per channel, whichever is smaller;
  - replay: `GET /v1/realtime/{channel}?after={seq}` authorised exactly like a subscription (same session,
    same channel ownership rules);
  - stale cursor: a cursor older than retention gets `410 resync`, and the client reloads state over REST.

## Acceptance criteria

- In the demo scenario, each of the three events arrives at the player's socket within one second of the
  domain event (end-to-end test).
- An event for player X never arrives on player Y's socket, and player Y's replay request for X's
  channel returns 404.
- Realtime server restarted between append and push: after reconnect the client's replay returns the
  missed message once.
- A cursor older than retention returns `410 resync`.
- **Cross-origin positive flow** (with MIO-134's two-origin setup): launch, REST call, websocket
  connect, session refresh while connected, all from the widget on its own origin inside the casino page.
