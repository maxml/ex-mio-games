---
id: MIO-162
title: Health, readiness, timeouts, graceful shutdown
epic: EPIC-15
priority: P1
money_impact: enabler
risk_class: concurrency
status: todo
depends_on: [MIO-001, MIO-066]
size: S
---

## Goal

Services start, stop and fail predictably.

## Scope

- `/health` (process up) and `/ready` (DB, broker, Redis reachable) on every service.
- Timeouts on every outbound call (DB, broker, casino adapters, payment provider).
- On SIGTERM: stop accepting, finish in-flight requests and messages, then exit within a deadline.

## Acceptance criteria

- With Postgres stopped, `/ready` returns 503 and `/health` returns 200.
- Sending SIGTERM during a redemption, at each durable boundary listed in MIO-066, leaves it in a
  consistent state (no half-written saga step); after restart it reaches the same final state as without
  the signal.
- A message being handled when SIGTERM arrives is either committed and acknowledged, or not acknowledged
  and redelivered; never acknowledged without its effect.
- A lint rule fails on an HTTP client created without a timeout.
