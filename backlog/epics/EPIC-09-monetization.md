---
id: EPIC-09
title: 'Monetization: operator billing, plans, metering, entitlements'
priority: P0
status: todo
---

# EPIC-09 Monetization

## Goal

MIO Games sells a subscription to casino operators. An operator can sign up alone, connect a casino,
see a test event arrive, pick a plan and pay. Usage is metered from events we already publish. Plan
limits are enforced atomically. Stripe sits behind a `PaymentProvider` interface: `fake` by default
(local, tests, demo), `stripe` when a key is set.

Players never pay through Stripe. Player coins are an internal ledger (EPIC-08).

## Tasks

| ID      | Title                                                                   | Priority |
| ------- | ----------------------------------------------------------------------- | -------- |
| MIO-090 | `PaymentProvider` interface: `fake` default, `stripe` behind a key      | P0       |
| MIO-091 | Plans and pricing: one table, trial, base fee plus usage                | P0       |
| MIO-092 | Operator self-serve onboarding                                          | P0       |
| MIO-093 | Checkout and subscription lifecycle, safe against out-of-order webhooks | P0       |
| MIO-094 | Billing webhooks: fail-closed and idempotent                            | P0       |
| MIO-095 | Usage metering from bus events                                          | P1       |
| MIO-096 | Entitlements: plan limits checked and counted atomically                | P1       |
| MIO-097 | Integration test console: send a test event and see it arrive           | P1       |
| MIO-098 | Invoices and billing history in the operator console                    | P1       |
| MIO-099 | Revenue view for the platform admin: MRR and usage per operator         | P1       |

## Exit criteria

A new operator goes from sign-up to an active paid plan (fake provider) without help, and the funnel
events for every step appear in the Varta analytics panel.
