---
id: MIO-163
title: Deckhand deploy manifest for all services
epic: EPIC-15
priority: P2
money_impact: enabler
risk_class: none
status: todo
depends_on: [MIO-002]
blocked_by: ['starter: Deckhand manifest for many services']
size: S
estimate_hours_base: 6
estimate_hours: 8
---

## Goal

Deploy with Deckhand, our blue-green deployment tool for Docker Compose apps; nothing new is invented.

## Scope

`.deckhand/deploy.yml` describing every service, its health check and its migration step.

## Acceptance criteria

- Deckhand's manifest validation passes in CI.
- A dry-run deploy lists every service in compose.
