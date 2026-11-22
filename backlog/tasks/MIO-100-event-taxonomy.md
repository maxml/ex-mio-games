---
id: MIO-100
title: Event taxonomy v1 (one-way door)
epic: EPIC-10
priority: P0
money_impact: enabler
risk_class: none
status: todo
depends_on: []
size: S
estimate_hours_base: 8
estimate_hours: 10
---

## Goal

Fix the analytics names and ids before the first event is emitted, because renaming later breaks history.

## Scope

- `docs/analytics/taxonomy.md` and a typed registry in `packages/contracts`.
- Naming: `domain.object_action` in past tense, plus `event_v`.
- Envelope: `kind: "product_event"`, `event`, `event_v`, `event_id` (UUIDv7), `tenant_id`, `actor_type`,
  `actor_id` (pseudonymous), `anon_id`, `session_id`, `consent`, `props` (flat, allow-listed keys).
- v1 events: operator funnel, player funnel, billing events (see MIO-102 to MIO-104).
- Shape compatible with common product analytics tools (`event`, `distinct_id`, `properties`) so another
  sink can be added later.

## Acceptance criteria

- The registry rejects an event name that does not match the naming pattern (unit test).
- A `props` key not in the event's allow-list fails validation.
- ADR records the one-way doors: event names, `tenant_id` format, `actor_id` scheme, `event_id` format.
