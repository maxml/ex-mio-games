---
id: MIO-188
title: 'Part E2: ten casino operators without ten codebases'
epic: EPIC-17
priority: P1
money_impact: enabler
risk_class: none
status: todo
depends_on: [MIO-057, MIO-052]
size: S
---

## Goal

Answer Part E question 2 with evidence from the running system.

## Scope

Section 2 of `docs/scaling.md`:

- One codebase; adapters per casino platform type, not per operator; operators on the same platform
  share an adapter and differ only in tenant configuration (keys, rules, tables, catalog, plan).
- What is configuration and what is code, as a table.
- The cost of adding the eleventh operator on a known platform (configuration only, self-serve) and on a
  new platform (one adapter plus passing the contract suite, MIO-057), with the estimate's basis.
- How per-tenant load is isolated (fair queues, per-tenant rate limits) and what changes at 10 operators.

## Acceptance criteria

- The first sentence answers the question directly.
- The claim "a new operator on a known platform needs no code" is backed by the two-operator parity run
  (MIO-052) and the self-serve onboarding test (MIO-092).
- The claim "a new platform needs one adapter" links to the change set that added Casino B.
