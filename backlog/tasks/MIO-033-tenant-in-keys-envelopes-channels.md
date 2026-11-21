---
id: MIO-033
title: Tenant in cache keys, broker envelopes and websocket channels
epic: EPIC-04
priority: P1
money_impact: enabler
risk_class: isolation
status: todo
depends_on: [MIO-032, MIO-015]
size: S
---

## Goal

Isolation holds outside the database too.

## Scope

- Redis keys built only through a helper that prefixes `t:{tenant_id}:`.
- Every broker message carries `tenant_id` in the envelope; consumers restore the tenant context from it
  and reject messages without one.
- Websocket channels are named per tenant and per user; subscribing to another tenant's channel is refused.

## Acceptance criteria

- A lint rule or test fails on a raw Redis key string outside the helper.
- A consumer test: a message without `tenant_id` goes to the DLQ and has no effect.
- A websocket test: a tenant A token cannot subscribe to a tenant B channel.
