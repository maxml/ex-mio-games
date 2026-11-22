---
id: MIO-090
title: '`PaymentProvider` interface: `fake` default, `stripe` behind a key'
epic: EPIC-09
priority: P0
money_impact: direct
risk_class: guard
status: todo
depends_on: [MIO-080]
size: M
estimate_hours_base: 20
estimate_hours: 24
---

## Goal

Operator billing is real, while the demo and the tests never depend on an external account.

## Scope

- Port: `createCustomer`, `createCheckout`, `getSubscription`, `cancelSubscription`, `reportUsage`,
  `verifyWebhook`, `parseWebhook`.
- `fake`: in-process, deterministic, with a local "pay" page and webhooks sent to our own endpoint.
- `stripe`: Stripe Billing in test mode, enabled only when `STRIPE_SECRET_KEY` is set.
- The provider choice is read once at start-up and logged.

## Acceptance criteria

- The same contract suite passes for `fake` always and for `stripe` when a test key is present in CI.
- With no key set, the service starts with `fake` and the full onboarding flow works.
- No Stripe type appears outside the adapter (lint import rule).
