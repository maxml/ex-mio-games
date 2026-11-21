---
id: MIO-015
title: Event envelope and contracts package (one-way door)
epic: EPIC-02
priority: P0
money_impact: enabler
risk_class: guard
status: todo
depends_on: []
blocked_by: ["starter: event bus (outbox, inbox, DLQ) on RabbitMQ"]
size: M
---

## Goal

One shared, versioned definition of every message between services and every public API body.

## Scope

- `packages/contracts`: zod schemas for HTTP bodies and domain events.
- Envelope: `event_id` (UUIDv7), `type`, `version`, `tenant_id`, `occurred_at`, `correlation_id`,
  `causation_id`, `payload`.
- Events v1: `DepositConfirmed`, `SpinGranted`, `SpinCompleted`, `CoinsCredited`, `CoinsReserved`,
  `CoinsReleased`, `RedemptionRequested`, `RedemptionStatusChanged`, `RedemptionIssued`, `RedemptionFailed`,
  `BalanceChanged`.
- Versioning rule: additive changes keep the version; breaking changes add a new version and both are
  consumed during migration.

## Acceptance criteria

- Publishing an event without `tenant_id` or `event_id` fails at the publisher (unit test).
- A consumer given an unknown `version` sends the message to the DLQ instead of guessing.
- A snapshot test of the exported JSON schemas fails on any breaking change.
