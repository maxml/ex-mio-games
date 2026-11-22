---
id: MIO-092
title: Operator self-serve onboarding
epic: EPIC-09
priority: P0
money_impact: direct
risk_class: identity
status: todo
depends_on: [MIO-043, MIO-051, MIO-054, MIO-060, MIO-062, MIO-065, MIO-093, MIO-101, MIO-123, MIO-133]
size: L
estimate_hours_base: 40
estimate_hours: 48
---

## Goal

An operator goes from "interested" to "paying" without talking to us. This is the start of the first
sellable slice.

## Scope

A minimal onboarding wizard on the operator console origin, built from `packages/ui` components (the full
console is MIO-131):

1. Sign up (creates the operator tenant and its owner; trial plan starts).
2. Choose the casino platform type and get integration keys: webhook secret and launch-token key.
3. Send a test deposit from the sandbox casino and see it arrive: the page shows the first accepted event
   (status read from the ingestion API; the live event log with websocket push is MIO-097).
4. Publish a rule, a wheel table and a store item from templates. The default rule template grants
   exactly one spin for a qualifying deposit.
5. Choose a plan and pay (MIO-093).

**Sandbox boundary.** Each tenant gets two key sets: sandbox and production. Only events verified with
the sandbox key are sandbox events; the flag is set by the server from the verifying key, never read from
the payload. Sandbox events create spins, coins and redemptions only for sandbox players (a separate
player namespace) in sandbox ledger accounts, and sandbox redemptions are issued only to the sandbox
simulator, never to a production casino endpoint. Sandbox operations are not metered; production
operations always are.

## Acceptance criteria

- An end-to-end test drives all five steps through the public API with the `fake` provider and ends with
  an `active` subscription; a Playwright test drives the same five steps through the wizard.
- Each step emits its operator funnel event (taxonomy MIO-100) exactly once; `integration.first_event_received`
  is emitted by ingestion (MIO-054) when the tenant's first event is accepted (a sandbox test event
  counts for this step), once per tenant.
- Integration secrets are shown once at creation, stored hashed or encrypted, and can be rotated.
- An operator who stops at step 3 can resume at step 4 later.
- A production-key event whose payload claims `test: true` (or any sandbox marker) is processed as
  production; a sandbox-key event naming a production player id creates nothing for that player.
- Funnel events are emitted by each step as business events from the taxonomy (MIO-100, MIO-101),
  asserted with the memory sink.

## Notes

The funnel query that reads these events is MIO-102, which comes after this task.
