---
id: MIO-189
title: 'Part E3: PvP, Missions and Kingdom Builder without coupling to the integration layer'
epic: EPIC-17
priority: P1
money_impact: enabler
risk_class: none
status: todo
depends_on: [MIO-070, MIO-015]
size: S
estimate_hours_base: 4
estimate_hours: 5
---

## Goal

Answer Part E question 3 for each of the three named features, with the boundary each one would have.

## Scope

Section 3 of `docs/scaling.md`, building on the ADR in MIO-070:

- The rule: new features consume canonical domain events (`DepositConfirmed`, `SpinCompleted`, ...) and
  call payments for coins; they never call an adapter or read a casino payload.
- For **Missions**, **PvP** and **Kingdom Builder** separately: which canonical events it consumes, which
  new events it publishes, which state it owns, whether it is a module in engagement or a new service and
  why, and what (if anything) it needs from the integration layer that does not exist yet (and how that
  is added as a canonical event, not a direct dependency).
- How a feature is switched on per tenant and per plan.

## Acceptance criteria

- The first sentence answers the question directly.
- Each of the three features has its own subsection with all items above.
- An architecture check (Nx module boundaries, MIO-007) shows that no feature module may import the
  integrations module; the section links that rule.
