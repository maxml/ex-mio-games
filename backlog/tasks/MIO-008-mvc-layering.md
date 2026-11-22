---
id: MIO-008
title: MVC layering convention and its lint check
epic: EPIC-01
priority: P1
money_impact: enabler
risk_class: none
status: todo
depends_on: [MIO-001]
size: S
---

## Goal

Keep server code simple: a plain MVC split that every service follows.

## Scope

- Controllers: all request data handling, as many checks as possible, mandatory validation (zod schemas
  from `contracts`).
- Services: application logic only. Some validation may live here when it needs domain state.
- Models: everything about data (TypeORM entities, repositories, queries, transactions).
- A lint rule: controllers do not import repositories; services do not import HTTP types.

## Acceptance criteria

- `docs/architecture/layers.md` describes the three layers with one example from the codebase.
- A fixture controller that imports a repository fails lint.
- A fixture controller endpoint without a validation schema fails a unit test that walks all routes.
