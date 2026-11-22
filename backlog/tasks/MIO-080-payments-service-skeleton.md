---
id: MIO-080
title: Payments service skeleton with its own database
epic: EPIC-08
priority: P0
money_impact: enabler
risk_class: none
status: todo
depends_on: [MIO-001]
blocked_by: ['starter: payments skeleton']
size: M
estimate_hours_base: 12
estimate_hours: 15
---

## Goal

All payments, coins and value go to one separate service from day one.

## Scope

- `payments` service with its own Postgres database and TypeORM migrations.
- Modules: `ledger` (player coins) and `billing` (operator subscriptions).
- Internal API only for coin writes (service token, MIO-046); public read API for balances.

## Acceptance criteria

- No other service has credentials for the payments database (compose and config test).
- `GET /health` and `GET /ready` (DB and broker reachable) answer correctly.
