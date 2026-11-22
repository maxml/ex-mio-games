---
id: MIO-203
title: Routes for coin history, cross-tenant admin tables and the usage chart, with the consoles live
epic: EPIC-13
priority: P2
money_impact: none
risk_class: isolation
status: todo
depends_on: [MIO-085, MIO-132]
size: M
estimate_hours_base: 24
estimate_hours: 29
---

## Goal

The remaining screens that are mock-only in live mode show real data: the player coin history, the platform
admin tables (tenants, plan, revenue, spins, depositors, funnel), the per-day usage chart, and the rules and
wheel read back into the operator console.

## Scope

- Player coin history route (the ledger history API of MIO-085 exposed to the widget through the BFF).
- A platform-staff-only cross-tenant read model for the admin console. It never uses a tenant connection.
- Per-day usage and the included allowance on the plan view.
- A route to read the published rules and wheel, so the console shows what is saved.
- Remove the matching entries from `docs/submission/known-gaps.md`.

## Acceptance criteria

- Each screen renders real service data in the live build, with no mock call (the adapter's mock-only list
  is empty for these calls; a test fails when a listed call goes to the mock).
- A tenant operator calling an admin route gets 403; a platform staff user sees every tenant.
- A player sees only their own history; another player's id answers 404.
- The usage chart sums to the usage total of the same period.
- Mutation: use the tenant connection for the admin read model. The isolation test goes red.

## Notes

Source: the web live-mode handoff (history, admin tables, usage chart and the rules and wheel read-back are
mock-only in live mode) and the known-gaps list (G-1, G-2, G-4, G-6). Estimate: five routes and the screens,
upper end of M.
