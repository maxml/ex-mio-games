---
id: MIO-043
title: Operator staff sign-up and sign-in, email unique per tenant
epic: EPIC-05
priority: P0
money_impact: direct
risk_class: identity
status: todo
depends_on: [MIO-042, MIO-030, MIO-031]
size: M
estimate_hours_base: 20
estimate_hours: 24
---

## Goal

The first step of operator self-serve onboarding: a person creates an operator account and signs in.

## Scope

- Sign-up creates an operator tenant and its first admin in one flow (saga with the provider call).
- Email and password sign-in; invite more staff with a role.
- Email unique within the tenant only.

## Acceptance criteria

- Sign-up with an email already used in another tenant succeeds and creates a new account.
- Sign-up with an email already used in the same tenant fails with a clear error.
- Five failed sign-ins in a minute lock the account for a short time (rate limit in Redis).
- `operator.signed_up` analytics event is emitted once per successful sign-up.
