---
id: MIO-012
title: 'ADR: which components are modules and which are services'
epic: EPIC-02
priority: P1
money_impact: enabler
risk_class: none
status: todo
depends_on: []
size: S
---

## Goal

Answer the Part A question "which components should initially be modules and which require independent
services", with the cost of each split stated.

## Scope

- Services: `identity` (trust boundary; tenants as a module inside), `engagement` (rules, wheel, store,
  redemption; integrations as a module inside), `payments` (all money and value: coin ledger and operator
  billing; strictest invariants and audit), `web` (frontend and BFF).
- Modules, not services: tenants, integrations, rules engine, wheel, store, analytics emitter.
- What would make us split a module out later (load profile, team ownership, compliance boundary).

## Acceptance criteria

- `docs/adrs/0001-services-and-modules.md` exists in the ADR template with a Confidence field.
- It lists, for each service, the data it owns and the events it publishes.
- It states the price of distribution (network calls, sagas, local setup) and how we pay it.
