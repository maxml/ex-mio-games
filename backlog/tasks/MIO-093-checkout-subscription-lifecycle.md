---
id: MIO-093
title: Checkout and subscription lifecycle, safe against out-of-order webhooks
epic: EPIC-09
priority: P0
money_impact: direct
risk_class: budget
status: todo
depends_on: [MIO-090, MIO-091, MIO-094, MIO-013]
size: M
estimate_hours_base: 24
estimate_hours: 29
---

## Goal

Operators pay, upgrade, downgrade and cancel; the tenant's status follows, and a late or reordered
webhook can never switch off a paying operator.

## Scope

- Checkout through the provider; subscription states `trialing`, `active`, `past_due`, `canceled`.
- Upgrade takes effect at once; downgrade at period end; cancellation keeps access until period end.
- **Ordering rule.** Webhooks are a signal, not the state. After a verified webhook (MIO-094) the handler
  fetches the current subscription from the provider (`getSubscription`) and applies it only if its
  provider version (update timestamp plus event sequence) is newer than the one stored; an older state is
  recorded in the inbox as `superseded` and changes nothing. A daily reconciliation compares every
  subscription with the provider and applies newer states the same way.
- **Tenant status ownership.** Payments owns subscription state and publishes
  `TenantBillingStatusChanged` (through its outbox). Identity owns the tenant's `active` or `suspended`
  status and changes it only by consuming that event (`past_due` beyond the grace period → `suspended`;
  `active` → `active`). Engagement and the other services keep a read-only projection of tenant status
  from identity's `TenantStatusChanged` event; ingestion and spins read the projection.

## Acceptance criteria

- The subscription becomes `active` only from a verified provider webhook, never from the browser redirect.
- **Out of order:** the `fake` provider delivers `subscription.updated (active)` and then an older
  `invoice.payment_failed (past_due)`; the subscription stays `active` and the tenant is never suspended.
  The same with the two events delivered concurrently.
- **Missed webhook:** a state change whose webhook was never delivered is applied by the next
  reconciliation run.
- A suspended tenant's ingestion returns 402 and grants nothing; reactivation resumes without data loss.
- Reader test: identity's tenant status and engagement's projection both show `suspended` after the
  grace period, and both show `active` after payment, described correctly in the operator console.
- `billing.plan_activated` and `billing.subscription_changed` are emitted as business events (MIO-101)
  on the matching transitions.
