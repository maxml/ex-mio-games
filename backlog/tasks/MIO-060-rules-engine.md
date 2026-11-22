---
id: MIO-060
title: "Rules engine: tenant-configured, versioned rules"
epic: EPIC-07
priority: P0
money_impact: direct
risk_class: guard
status: todo
depends_on: [MIO-050, MIO-032, MIO-045]
size: M
estimate_hours_base: 20
estimate_hours: 24
---

## Goal

Operators decide what earns spins without code changes (assignment Part A: rules engine; admin configuration).

## Scope

- Rule: trigger (canonical event type), conditions (for example `amount_minor >= X`, currency), action
  (`grant_spins: N`, wheel id), active window, per-player caps.
- Rules are versioned; an event is evaluated against the version active at its `occurred_at`, and the
  rule version is stored with the outcome.
- Rules are data validated by a zod schema, not code; no expression evaluation of user-supplied strings.
- Operator API to create, publish and retire rules.

## Acceptance criteria

- A deposit of exactly the threshold grants N spins; one minor unit below grants none.
- Publishing a new rule version does not change outcomes already recorded.
- A rule with an unknown action or a negative spin count is rejected at the API with 422.
- Rule evaluation is a pure function with table-driven unit tests.
