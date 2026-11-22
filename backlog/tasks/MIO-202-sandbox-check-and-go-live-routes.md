---
id: MIO-202
title: Service routes for the sandbox check and go-live, and the console switched to them
epic: EPIC-13
priority: P1
money_impact: direct
risk_class: ownership
status: todo
depends_on: [MIO-131, MIO-133]
size: M
estimate_hours_base: 20
estimate_hours: 24
---

## Goal

An operator can run the sandbox check, start go-live and confirm the first live deposit against the real
services. In live mode these three screens are answered by the web mock because no route exists.

## Scope

- Routes for: run the sandbox check (a test deposit through the sandbox environment, spin, reward issued),
  start go-live (needs a paid plan and a production credential), confirm the first live deposit.
- State per tenant stored in the service that owns it, with the steps of the onboarding checklist.
- The console and the BFF call the routes; remove these calls from the mock-only list in
  `docs/submission/known-gaps.md` (entry G-4).

## Acceptance criteria

- With the live web build and no mock, an operator completes sandbox check, go-live and first live deposit
  on a fresh stack; a browser test (or a scripted one) records each step as done.
- Go-live without a paid plan answers 409 with its own code, and the step stays open.
- A second tenant cannot read or advance the first tenant's steps (404).
- The sandbox check writes nothing to production wallets or production funnels (test on both).
- Mutation: skip the paid-plan check. The go-live test goes red.

## Notes

Source: the web live-mode handoff (sandbox check, go-live and the first live deposit are mock-only in live
mode) and the known-gaps list. Estimate: spans two services and the console, upper end of M.
