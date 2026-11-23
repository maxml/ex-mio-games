---
id: MIO-221
title: Run the operator-roles e2e in CI and find the flaky web test
epic: EPIC-13
priority: P2
money_impact: none
risk_class: none
status: todo
depends_on: []
size: S
estimate_hours_base: 3
estimate_hours: 4
---

## Goal

The role switch and the guard redirect are checked in a real browser on every change, and the web unit test
that fails under load has a name.

## Scope

- CI does not run web e2e, so A-SHOT-1 is unguarded. The cheapest fix is one step in the `unit` job, which
  already runs `playwright install --with-deps chromium`:
  `NEXT_PUBLIC_MIO_API=mock pnpm --filter @ex-mio/web exec playwright test operator-roles`.
  It costs one `next build`. The screenshots it writes are discarded in CI.
- Nx flagged `@ex-mio/web:test` as flaky in the local gate. The test is not identified yet.

## Acceptance criteria

- The `unit` job runs the `operator-roles` spec and fails when a role sees another role's nav.
- The flaky web test is named, with its cause, and fixed or recorded with a reason.

## Notes

From the re-review of the operator UI rework fix round. What CI covers today: the UIR-5 unit test, and
A-NAV-1 and A-GUARD-1 in jsdom. What it does not: the role switch and guard redirect in a real browser, and
whether the screenshots are current. The first push of commit 3b592ac failed with `LOCAL GATE RED` on
`@ex-mio/web:test`. The log was not kept. A standalone web run straight after passed (34 files, 283 tests),
and the second push gave `LOCAL GATE GREEN` with "Nx detected a flaky task".
