---
id: MIO-092
title: Operator self-serve onboarding
epic: EPIC-09
priority: P0
money_impact: direct
risk_class: identity
status: todo
depends_on: [MIO-043, MIO-093, MIO-097]
size: L
---

## Goal

An operator goes from "interested" to "paying" without talking to us.

## Scope

Steps in the operator console:

1. Sign up (creates the operator tenant and its owner; trial plan starts).
2. Choose the casino platform type and get integration keys: webhook secret and launch-token key.
3. Send a test deposit from the sandbox casino and see it arrive (MIO-097).
4. Configure a rule, a wheel table and a store item from templates.
5. Choose a plan and pay (MIO-093).

## Acceptance criteria

- An end-to-end test drives all five steps through the public API with the `fake` provider and ends with
  an `active` subscription.
- Each step emits its operator funnel event exactly once (MIO-102).
- Integration secrets are shown once at creation, stored hashed or encrypted, and can be rotated.
- An operator who stops at step 3 can resume at step 4 later.
