---
id: MIO-084
title: 'Reconciliation job and ledger conservation report'
epic: EPIC-08
priority: P1
money_impact: direct
risk_class: budget
status: todo
depends_on: [MIO-081, MIO-066]
size: M
---

## Goal

If the materialised balance ever drifts from the ledger, or held coins drift from open redemptions, we
know within an hour. A reviewer can see in one report that no coins were created or lost.

## Scope

- Scheduled job per tenant (hourly), and the same check as a command (`pnpm ledger:report`):
  - for every account, `sum(credits) - sum(debits)` over its legs equals the materialised balance;
  - every journal transaction is balanced (repeats the commit-time check over history);
  - held coins per player equal the sum of holds in `HELD` state, and each `HELD` hold matches a
    redemption in `RESERVED`, `ISSUING`, `UNKNOWN`, `ISSUED`, `REJECTED` or `NEEDS_REVIEW` in engagement;
  - every `COMPLETED` redemption has exactly one capture, every `RELEASED` one release, every `REFUNDED`
    one refund.
- **Conservation report** per tenant: coins issued (spin awards and adjustments), currently available,
  currently held, captured (spent on rewards), released, refunded, and the identity
  `issued = available + held + captured - refunded` (refunds return captured coins to available). Printed
  by `pnpm demo` at the end (MIO-005, MIO-053) and stored with each run.
- Writes a durable run record (start, end, accounts checked, mismatches by kind, the report) and emits a
  metric and an alert on mismatch.
- **Repair policy:** never fixes data automatically. A mismatch opens an alert with the account and the
  evidence; the fix is an audited adjustment through MIO-082 by platform staff with a reason.

## Acceptance criteria

- A test that corrupts one balance row directly in the DB makes the next run report exactly that account.
- A test that leaves a `HELD` hold without a matching redemption reports exactly that hold.
- The conservation identity holds after `pnpm demo` and after `pnpm demo --faults` (asserted, not only
  printed).
- **Reader test:** the last run's record is read back by the platform admin API and console and described
  correctly (time, accounts checked, mismatch count by kind).
- A run that fails to complete is recorded as `failed`, not as "no mismatches"; a stale last run (older
  than two hours) is shown as a failure.
