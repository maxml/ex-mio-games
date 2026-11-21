---
id: MIO-111
title: "Resilient client: reconnect with backoff, resubscribe, heartbeat, catch-up"
epic: EPIC-11
priority: P1
money_impact: enabler
risk_class: none
status: todo
depends_on: [MIO-110, MIO-112]
blocked_by: ["starter: resilient websocket"]
size: M
---

## Goal

The socket must not die: when it drops, it comes back on its own and nothing is missed.

## Scope

- Client heartbeat; reconnect with exponential backoff and jitter; resubscribe to channels.
- Each message carries a per-channel sequence number; after reconnect the client asks the replay endpoint
  of the server-side journal (MIO-112) for anything after its last sequence, and on `410 resync` reloads
  its state over REST.
- UI shows a small "reconnecting" state, never a dead widget.

## Acceptance criteria

- Killing the websocket server container and starting it again: the client reconnects within 10 seconds and shows
  events emitted during the outage (end-to-end test).
- Network offline for 60 seconds, then online: the client catches up with no duplicates in the UI.
- No reconnect storm: 1,000 simulated clients reconnect spread over the backoff window (load test).
