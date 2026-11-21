---
id: MIO-044
title: "Player identity mapping: casino launch token to player session"
epic: EPIC-05
priority: P0
money_impact: direct
risk_class: identity
status: todo
depends_on: [MIO-042, MIO-050]
size: M
---

## Goal

A casino player opens the widget and is recognised as the same player whose deposits the casino reports.

## Scope

- Casino signs a launch token (per-tenant key) carrying its own player id; identity verifies signature,
  expiry and audience **before** any provider call, then issues our session.
- Link table `(tenant_id, casino_source, external_player_id) ↔ user_id`, created on first launch or on
  first deposit event, whichever comes first.
- Deposit ingestion resolves the player through the same link table.

## Acceptance criteria

- Launch token with a bad signature, expired, or for another tenant: rejected, no session, no link row.
- Deposit arrives before the first launch: the later launch maps to the same `user_id` and sees the spin.
- The same external player id in two tenants maps to two different `user_id`s.
- Concurrent first launches for one external id create exactly one link row.

## Notes

Assignment Part A: player identity mapping.
