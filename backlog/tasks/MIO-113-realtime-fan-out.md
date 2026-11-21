---
id: MIO-113
title: Fan-out across service instances
epic: EPIC-11
priority: P2
money_impact: none
risk_class: none
status: todo
depends_on: [MIO-112]
size: S
---

## Goal

Realtime keeps working when the websocket server runs as more than one instance.

## Scope

Each websocket server instance binds its own queue to the realtime exchange (or uses Redis pub/sub) and delivers
only to sockets it holds.

## Acceptance criteria

- With two websocket server instances and the player connected to either one, every push arrives exactly once.
