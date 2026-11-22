---
id: MIO-055
title: Event deduplication in the same transaction as the effect
epic: EPIC-06
priority: P0
money_impact: direct
risk_class: admission
status: todo
depends_on: [MIO-054]
size: S
---

## Goal

The same casino event never counts twice, whatever the casino or the broker does.

## Scope

- `UNIQUE (tenant_id, source, external_event_id)` on the inbound events table.
- Insert of the inbound event, its outbox message and its processing status happen in one transaction.
- A duplicate returns 200 with the original processing result, so the casino stops retrying.

## Acceptance criteria

- Ten parallel deliveries of the same event produce one row and one outbox message.
- A duplicate gets 200 and the same response body as the first delivery.
- The same `external_event_id` from two different tenants is two events.
