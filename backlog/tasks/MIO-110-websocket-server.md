---
id: MIO-110
title: "Websocket server: authenticated, tenant-scoped channels"
epic: EPIC-11
priority: P1
money_impact: enabler
risk_class: isolation
status: todo
depends_on: [MIO-042, MIO-033, MIO-135]
blocked_by: ["starter: resilient websocket"]
size: M
estimate_hours_base: 20
estimate_hours: 24
---

## Goal

A mandatory websocket between the frontend and the backend.

## Scope

- Websocket server in the web BFF or a small realtime module; authenticates with the session on connect and on
  every token refresh.
- Channels: `tenant:{tid}:user:{uid}` for players, `tenant:{tid}:ops` for operator staff.
- Server-to-client messages only carry event type, ids and small payloads; clients fetch details over REST.

## Acceptance criteria

- A connection without a valid session is closed with an auth error code.
- Subscribing to another tenant's or another user's channel is refused (test).
- An expired session closes the socket; a refreshed one keeps it open.
