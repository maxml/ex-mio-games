---
id: MIO-021
title: "Architecture IR: system context and containers"
epic: EPIC-03
priority: P2
money_impact: none
risk_class: none
status: needs-owner-review
depends_on: [MIO-020]
size: M
estimate_hours_base: 12
estimate_hours: 15
---

## Goal

The system context (casinos, players, operators, platform staff, Varta, Deckhand) and the container
view (services, broker, databases, Redis, web) as archify JSON IR.

## Scope

- `docs/architecture/system.architecture.json` and `containers.architecture.json`.
- Rendered HTML next to them and a PNG for the README.

## Acceptance criteria

- `pnpm arch:validate` passes on both files.
- Every service in compose and every app in the Nx graph appears in the container view.

## Notes

The owner reviews the archify tasks before work starts.
