---
id: MIO-070
title: "ADR: new features (Missions, PvP, Kingdom Builder) consume canonical events only"
epic: EPIC-07
priority: P1
money_impact: enabler
risk_class: none
status: todo
depends_on: [MIO-050, MIO-015]
size: S
estimate_hours_base: 4
estimate_hours: 5
---

## Goal

Answer Part E question 3: introduce PvP, Missions and Kingdom Builder without coupling each feature to
the casino integration layer.

## Scope

- ADR: features subscribe to canonical domain events (`DepositConfirmed`, `SpinCompleted`,
  `CoinsCredited`) and grant through the same primitives (spin credits, payments coin operations,
  store rewards). Only the integrations module knows casino shapes.
- A sketch per feature: Missions (progress counters from events), PvP (matches between players of one
  tenant, prizes as coins), Kingdom Builder (spends coins, earns from missions).
- Where each feature would live (module in engagement first) and when it would become a service.

## Acceptance criteria

- The ADR has a dependency diagram showing no edge from any feature to the integrations module.
- A lint boundary rule that forbids feature modules from importing integrations is added now, with a fixture test.
