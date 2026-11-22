---
id: MIO-144
title: "Part C: failed reward issuance and compensation"
epic: EPIC-14
priority: P1
money_impact: direct
risk_class: budget
status: todo
depends_on: [MIO-066]
size: S
estimate_hours_base: 8
estimate_hours: 10
---

## Goal

Prove that a final casino rejection returns the held coins exactly once, and that compensation of a
captured spend (a refund) also happens at most once.

## Acceptance criteria

- Simulator `reject`: redemption ends `REJECTED` then `RELEASED`; available balance equals the balance
  before the redemption; no reward in the simulator; no refund journal transaction exists.
- The `ReleaseHold` command delivered 3 times: one release.
- Crash between `REJECTED` and the release: after restart the release happens once.
- `CaptureHold` arriving after the release: rejected `hold_already_released`, redemption `NEEDS_REVIEW`,
  ledger conserved.
- Casino revokes a confirmed reward: `COMPLETED` then `REFUNDED`; `RefundCapture` delivered 3 times
  produces one refund transaction; a second revocation for the same redemption is rejected.
- A compensation step that fails (payments unavailable) is retried from the outbox and completes once
  when payments comes back; the redemption never shows `RELEASED` before payments confirmed it.
- Mutation: skip the release step, then the balance assertion goes red; remove the idempotency key on
  release, then the redelivery test goes red; allow capture after release, then the conservation check
  goes red.
