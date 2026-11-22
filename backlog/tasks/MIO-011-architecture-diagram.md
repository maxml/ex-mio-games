---
id: MIO-011
title: Architecture diagram (Mermaid, renders on GitHub)
epic: EPIC-02
priority: P1
money_impact: enabler
risk_class: none
status: todo
depends_on: []
size: S
estimate_hours_base: 4
estimate_hours: 5
---

## Goal

A diagram that shows services, modules, the broker, databases, the casinos and the frontends, readable
directly on GitHub.

## Scope

- Mermaid diagram in `docs/architecture/README.md`: casino A and B simulators, engagement (integrations,
  rules, wheel, store, redemption), payments (ledger, billing), identity (tenants), web (widget, consoles,
  BFF), RabbitMQ, Postgres per service, Redis, Varta, Deckhand.
- A sequence diagram for the 8-step flow.

## Acceptance criteria

- Both diagrams render on GitHub (checked with the Mermaid CLI in CI).
- Every node in the diagram exists as a project in the Nx graph or a service in compose, and the other way round.

## Notes

The archify version (EPIC-03) can replace or complement this once the owner approves that epic.
