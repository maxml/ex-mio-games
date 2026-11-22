---
id: MIO-026
title: "Drift check: IR against Nx project graph, compose and contracts"
epic: EPIC-03
priority: P2
money_impact: none
risk_class: guard
status: needs-owner-review
depends_on: [MIO-021, MIO-022, MIO-023]
size: M
estimate_hours_base: 16
estimate_hours: 20
---

## Goal

archify does not read code, so a small script compares the diagrams with reality.

## Scope

`tools/arch-drift.ts` compares:

- IR container nodes with `nx show projects --json` (apps) and `docker compose config --services`;
- IR message names with events and endpoints exported from `packages/contracts`;
- ERD tables and columns with TypeORM entity metadata.

## Acceptance criteria

- Adding a service to compose without adding it to the IR fails CI with the missing name.
- Renaming an event in contracts without updating the sequence diagram fails CI.
- The script has its own tests with fixtures for each kind of drift.

## Notes

The owner reviews the archify tasks before work starts.
