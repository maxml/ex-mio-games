---
id: MIO-171
title: '`CONTRACTS.md`: one place for every contract'
epic: EPIC-16
priority: P1
money_impact: enabler
risk_class: none
status: todo
depends_on: [MIO-015]
size: S
---

## Goal

Agents and people change contracts deliberately, never by accident.

## Scope

`CONTRACTS.md` lists every public and internal API, every event with its version, the analytics taxonomy,
the casino adapter interface, and the external contracts (Varta telemetry, Deckhand manifest). Each entry
points to its source of truth in `packages/contracts`.

## Acceptance criteria

- A CI check fails if an event or endpoint exported from `packages/contracts` is missing from `CONTRACTS.md`.
