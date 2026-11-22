---
id: MIO-200
title: Service-mode auth context carries no environment, so no handler can read a default one
epic: EPIC-05
priority: P2
money_impact: none
risk_class: isolation
status: todo
depends_on: [MIO-046]
size: M
estimate_hours_base: 8
estimate_hours: 10
---

## Goal

A future internal route that reads the environment from the auth context fails to compile or fails loudly,
instead of silently getting production.

## Scope

- Today the service-token path of the shared guard builds an auth context with `sandbox: false`. No
  internal handler reads it now (each takes the environment from a body, a path, a stored row or the
  ticket claim), but the default is a trap.
- Make the auth context a discriminated union: a user context has `sandbox`, a service context has none.
- Fix every reader the type change reveals.

## Acceptance criteria

- A type-level test shows that reading `sandbox` on a service context does not compile.
- A runtime test: a service-token request to a test route that reads the environment from the context gets
  a 500 with a clear internal error code, never `false`.
- All existing internal routes (reserve, capture, release, refund, balance read, redeem, resolve player)
  keep their tests green without change to their environment source.
- Mutation: restore `sandbox: false` on the service context. The type test and the runtime test go red.

## Notes

Source: the re-review of the fix round (finding R9, a latent default in service mode).
