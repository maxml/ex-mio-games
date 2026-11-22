---
id: EPIC-11
title: Realtime websocket between frontend and backend
priority: P1
status: todo
---

# EPIC-11 Realtime

## Goal

A websocket between the frontend and the backend is mandatory. It must not die: it reconnects,
resubscribes and catches up on anything missed. Players see new spins, balance changes and reward
status without reloading.

## Tasks

| ID      | Title                                                                                           | Priority |
| ------- | ----------------------------------------------------------------------------------------------- | -------- |
| MIO-110 | Websocket server: authenticated, tenant-scoped channels                                         | P1       |
| MIO-111 | Resilient client: reconnect with backoff, resubscribe, heartbeat, catch-up                      | P1       |
| MIO-112 | Push events with server-side catch-up: spin granted, balance changed, redemption status changed | P1       |
| MIO-113 | Fan-out across service instances                                                                | P2       |
