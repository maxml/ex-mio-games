---
id: MIO-007
title: Nx module boundaries enforced in lint
epic: EPIC-01
priority: P1
money_impact: enabler
risk_class: guard
status: todo
depends_on: [MIO-001]
blocked_by: ['starter: Nx module boundaries v2']
size: S
---

## Goal

There will be many modules. Boundaries are enforced by tooling, not by memory.

## Scope

- Tags per project (`scope:identity`, `scope:engagement`, `scope:payments`, `scope:web`, `scope:shared`,
  `type:app`, `type:feature`, `type:data`, `type:contracts`).
- Rules: services never import each other's code, only `contracts`; the integrations module is reachable
  only inside engagement; nothing outside payments imports ledger internals.

## Acceptance criteria

- A test fixture that imports `payments` internals from `engagement` fails lint.
- A test fixture that imports `contracts` from any service passes lint.
- The rule set is documented in `docs/architecture/boundaries.md`.
