---
id: MIO-102
title: Operator funnel instrumentation
epic: EPIC-10
priority: P0
money_impact: direct
risk_class: none
status: todo
depends_on: [MIO-101, MIO-092]
size: S
estimate_hours_base: 8
estimate_hours: 10
---

## Goal

See where operators drop out between sign-up and payment.

## Scope

`operator.signed_up → integration.key_created → integration.first_event_received →
engagement.config_published → billing.plan_activated`, each emitted server-side, once per tenant.

## Acceptance criteria

- The onboarding end-to-end test (MIO-092) asserts each funnel event once, in order, with the same `tenant_id`.
- Retrying any step does not emit a second copy (one intent row per tenant and step through the `dedupe_key` unique constraint, MIO-101; the `event_id` stays a random UUIDv7).
- The funnel is visible in the first sellable slice: `pnpm analytics:funnel` reads the collected events
  (through Varta when its product events stream exists, otherwise from the local event log the emitter
  writes) and prints the count per step for a period and tenant. Reader test: after the onboarding test,
  the command shows exactly one tenant at every step.

## Notes

The Varta panel (MIO-106) later shows the same numbers.
