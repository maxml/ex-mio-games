---
id: MIO-056
title: '`DepositConfirmed` published through the outbox to RabbitMQ'
epic: EPIC-06
priority: P0
money_impact: enabler
risk_class: concurrency
status: todo
depends_on: [MIO-055, MIO-015]
blocked_by: ['starter: event bus (outbox, inbox, DLQ) on RabbitMQ']
size: M
---

## Goal

Processing is asynchronous and survives crashes: an accepted event is always processed, and only once.

## Scope

- Outbox relay publishes `DepositConfirmed` with publisher confirms; marks the row sent only after the
  broker acknowledges.
- Consumers use an inbox table keyed by `event_id`, written in the same transaction as their effect.
- Failed messages go to a DLQ after N attempts with backoff; a `replay` command re-queues them.

## Acceptance criteria

- Killing the relay after publish but before marking the row sent leads to a redelivery that the inbox
  drops (one effect).
- Killing a consumer mid-transaction leads to one effect after restart.
- A poison message lands in the DLQ after N attempts and `replay` processes it once fixed.
