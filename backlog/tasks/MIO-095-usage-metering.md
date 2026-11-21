---
id: MIO-095
title: Usage metering from bus events
epic: EPIC-09
priority: P0
money_impact: direct
risk_class: budget
status: todo
depends_on: [MIO-056, MIO-091]
size: M
---

## Goal

We bill for usage using events we already publish, with no second collection path.

## Scope

- Payments consumes `DepositConfirmed`, `SpinCompleted`, `RedemptionIssued` and player activity.
- Meters per tenant and billing period: monthly active players (distinct), spins, issued rewards.
- Inbox dedupe by `event_id`; usage reported to the provider at period end (or daily) with an idempotency key.

## Acceptance criteria

- Redelivered events do not increase meters.
- The same player active on ten days counts once as a monthly active player.
- The usage report for a period, sent twice, is billed once by the provider (fake asserts it).
- Metered totals equal a direct count from engagement data in a seeded test.
