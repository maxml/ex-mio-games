---
id: MIO-083
title: Balance readable everywhere (read API, cache, change event)
epic: EPIC-08
priority: P0
money_impact: direct
risk_class: ownership
status: todo
depends_on: [MIO-082]
size: S
estimate_hours_base: 8
estimate_hours: 10
---

## Goal

Any service and the player widget can read a coin balance; only payments can change it.

## Scope

- `GET /v1/me/balance` (player) and `GET /v1/players/{id}/balance` (operator, own tenant).
- Redis cache keyed per tenant, invalidated on `BalanceChanged`; the cache is never used for a write decision.
- `BalanceChanged` event consumed by the websocket server.

## Acceptance criteria

- After a credit, the read API returns the new balance within one second (integration test).
- With Redis stopped, balance reads still work (fall back to the DB).
- A spend decision is never made from the cache (code check: debit paths do not use the cache client).
- A player asking for another player's balance of the same tenant gets 404; an operator of tenant A asking
  for a player of tenant B gets 404; the cache key includes tenant and account, and a cache entry written
  for one player is never served to another (test with two players and a warm cache).
