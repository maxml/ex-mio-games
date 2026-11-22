---
id: MIO-066
title: 'Redemption saga: hold, issue, capture or release, with a full state-transition table'
epic: EPIC-07
priority: P0
money_impact: direct
risk_class: locks
status: todo
depends_on: [MIO-013, MIO-065, MIO-082, MIO-051, MIO-086]
blocked_by: ['starter: idempotency package']
size: L
estimate_hours_base: 48
estimate_hours: 58
---

## Goal

Assignment steps 6 and 7: the player redeems coins for a store item, and MIO requests issuance through
the casino adapter. No reward is issued twice, no coins are lost or created, and every step survives a
crash. The transition table below is the test oracle: a reviewer can check every row.

## Terms

- **Hold:** payments moves coins from the player's available balance to a held balance. Coins are not
  spent yet. Owner: payments.
- **Capture:** payments turns the hold into a spend (held coins leave the player). Done once, only after
  the casino confirmed the reward.
- **Release:** payments returns held coins to available. Used when the casino definitively rejected the
  reward. A release is not a refund: nothing was spent.
- **Refund:** payments reverses a capture with a new compensating journal transaction. Used only when the
  casino revokes a reward it had confirmed, or an operator compensates through an audited adjustment.
  At most one refund per redemption.

## Two reservations, two databases, one order

There is no transaction across services. Engagement owns the catalog, so it reserves **stock and the
per-player limit** in its own database when the redemption is created. Payments owns coins, so it
reserves **coins** (the hold) in its own database afterwards. Order: stock-and-limit first, then coins.
Compensation runs in reverse: a rejected coin hold releases the stock-and-limit reservation; a final
casino rejection releases the coin hold first and the stock-and-limit reservation when `HoldReleased`
arrives. The price and the reward mapping are frozen on the redemption at order time; later catalog
edits never change an open redemption.

## Owners, commands and events

| Owner                                              | State it owns                                                                | Commands it accepts                                        | Events it publishes                                                                                                 |
| -------------------------------------------------- | ---------------------------------------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| engagement (redemption)                            | redemption status, item and price snapshot, casino reference, attempt count  | `POST /v1/redemptions` (player)                            | `RedemptionRequested`, `RedemptionStatusChanged`, `RedemptionIssued`, `RedemptionRejected`, `RedemptionNeedsReview` |
| payments (hold)                                    | hold status `HELD`, `CAPTURED`, `RELEASED`, `REFUNDED`; journal transactions | `PlaceHold`, `CaptureHold`, `ReleaseHold`, `RefundCapture` | `HoldPlaced`, `HoldRejected`, `HoldCaptured`, `HoldReleased`, `CaptureRefunded`, `HoldCommandRejected`              |
| casino adapter (integrations module in engagement) | provider request log                                                         | `issueReward(key)`, `getRewardStatus(key)`                 | (returns results; no events of its own)                                                                             |

Commands travel through the sender's outbox and are handled through the receiver's inbox. Every command
carries the business-operation id from MIO-086 as its idempotency key: `hold:{redemption_id}`,
`capture:{redemption_id}`, `release:{redemption_id}`, `refund:{redemption_id}`. The casino idempotency key
is `redeem:{redemption_id}` on every attempt.

## Redemption state-transition table

| From                   | Trigger                                                                      | Guard                                                                      | To                          | Durable effect in the same transaction                                                                                                                                                                                                                             |
| ---------------------- | ---------------------------------------------------------------------------- | -------------------------------------------------------------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| (none)                 | `POST /v1/redemptions`                                                       | player owns the session; item active; stock and per-player limit available | `REQUESTED`                 | in the **engagement** database only: redemption row with `operation_id`, item id, item version, frozen price and frozen reward mapping; a stock-and-limit reservation row (conditional decrement of stock and of the player's remaining limit); outbox `PlaceHold` |
| `REQUESTED`            | `HoldPlaced`                                                                 | hold amount equals the frozen price                                        | `RESERVED`                  | status change; outbox `IssueReward` job                                                                                                                                                                                                                            |
| `REQUESTED`            | `HoldRejected` (insufficient funds)                                          | none                                                                       | `REJECTED_FUNDS` (final)    | status change; stock-and-limit reservation released; no casino call ever                                                                                                                                                                                           |
| `RESERVED`             | issue job starts                                                             | none                                                                       | `ISSUING`                   | attempt recorded **before** the adapter call                                                                                                                                                                                                                       |
| `ISSUING`              | adapter success                                                              | none                                                                       | `ISSUED`                    | casino reference stored; outbox `CaptureHold`                                                                                                                                                                                                                      |
| `ISSUING`              | adapter definitive rejection                                                 | rejection code is on the adapter's final list                              | `REJECTED`                  | reason stored; outbox `ReleaseHold`                                                                                                                                                                                                                                |
| `ISSUING`              | timeout, 5xx, network error, unparseable reply                               | none                                                                       | `UNKNOWN`                   | attempt outcome stored; status inquiry scheduled (MIO-068)                                                                                                                                                                                                         |
| `UNKNOWN`              | status inquiry: issued                                                       | none                                                                       | `ISSUED`                    | as `ISSUING → ISSUED`                                                                                                                                                                                                                                              |
| `UNKNOWN`              | status inquiry: casino has no record                                         | attempts left                                                              | `ISSUING`                   | retry with the same casino key                                                                                                                                                                                                                                     |
| `UNKNOWN`              | status inquiry: definitive rejection                                         | none                                                                       | `REJECTED`                  | as `ISSUING → REJECTED`                                                                                                                                                                                                                                            |
| `UNKNOWN`              | still unknown past the maximum age (24 h) or attempts exhausted              | none                                                                       | `NEEDS_REVIEW`              | alert; coins stay held; never released automatically                                                                                                                                                                                                               |
| `ISSUED`               | `HoldCaptured`                                                               | none                                                                       | `COMPLETED` (final success) | status change; stock-and-limit reservation committed                                                                                                                                                                                                               |
| `REJECTED`             | `HoldReleased`                                                               | none                                                                       | `RELEASED` (final failure)  | status change; stock-and-limit reservation released                                                                                                                                                                                                                |
| `COMPLETED`            | casino reports the reward revoked, or audited operator compensation          | none                                                                       | `REFUNDED` (final)          | outbox `RefundCapture`                                                                                                                                                                                                                                             |
| `REJECTED`, `RELEASED` | late success from the casino (callback or inquiry)                           | none                                                                       | `NEEDS_REVIEW`              | alert; no automatic coin movement                                                                                                                                                                                                                                  |
| `ISSUED`, `COMPLETED`  | late rejection from the casino                                               | none                                                                       | `NEEDS_REVIEW`              | alert; no automatic coin movement                                                                                                                                                                                                                                  |
| any state              | duplicate of an already applied trigger (same event id or same casino reply) | none                                                                       | unchanged                   | none (inbox dedupe)                                                                                                                                                                                                                                                |
| `NEEDS_REVIEW`         | operator resolves with a reason (`issued` or `not_issued`)                   | operator role; audit entry                                                 | `ISSUED` or `REJECTED`      | normal capture or release follows                                                                                                                                                                                                                                  |

Every pair not in this table is rejected (MIO-067 tests all pairs).

## Hold state-transition table (payments)

| From       | Command                              | To                   | Repeated command         | Conflicting command                                                                                         |
| ---------- | ------------------------------------ | -------------------- | ------------------------ | ----------------------------------------------------------------------------------------------------------- |
| (none)     | `PlaceHold` with enough available    | `HELD`               | same result, one hold    | n/a                                                                                                         |
| (none)     | `PlaceHold` without enough available | none, `HoldRejected` | same rejection           | n/a                                                                                                         |
| `HELD`     | `CaptureHold`                        | `CAPTURED`           | same result, one capture | `ReleaseHold` after capture: `HoldCommandRejected hold_already_captured`                                    |
| `HELD`     | `ReleaseHold`                        | `RELEASED`           | same result, one release | `CaptureHold` after release: `HoldCommandRejected hold_already_released`, redemption goes to `NEEDS_REVIEW` |
| `CAPTURED` | `RefundCapture`                      | `REFUNDED`           | same result, one refund  | `RefundCapture` on a hold that was never captured: rejected                                                 |

## Acceptance criteria

- Insufficient balance: `REJECTED_FUNDS`, the API returns 409 `insufficient_funds`, no hold, no casino call.
- Casino accepts: one redemption `COMPLETED`, one hold `CAPTURED`, one reward in the simulator, balance
  reduced by exactly the price snapshot.
- Casino rejects: `REJECTED` then `RELEASED`; the player's available balance equals the value before the
  redemption; no reward in the simulator; no refund transaction exists (a release is not a refund).
- Price or reward mapping changed in the catalog after `REQUESTED`: the hold, the capture and every
  issuance attempt use the frozen values.
- Stock of 1 and two players redeeming in parallel: one `REQUESTED`, the other rejected `out_of_stock`
  with no hold placed; after a `RELEASED` redemption the stock is available again.
- `hold_id` equals `redemption_id`; each phase uses its own key (`hold:`, `capture:`, `release:`,
  `refund:` plus the redemption id) and the allowed phase order is the hold table below.
- **Crash at every durable boundary.** A test harness kills the process at each boundary below, restarts
  it, and checks the final state equals the no-crash run, with exactly one reward in the simulator and
  ledger conservation (the test itself sums the player's available, held and captured coins):
  1. after `REQUESTED` commits, before `PlaceHold` is relayed;
  2. after payments commits the hold, before `HoldPlaced` is consumed;
  3. after `ISSUING` commits, before the adapter call;
  4. after the casino issued the reward, before `ISSUED` is recorded (recovered by status inquiry, not by
     a second issue);
  5. after `ISSUED`, before `CaptureHold` is relayed;
  6. after payments captures, before `HoldCaptured` is consumed;
  7. after `REJECTED`, before `ReleaseHold` is relayed;
  8. after payments releases, before `HoldReleased` is consumed.
- **Duplicate and late responses.** The simulator sends the success callback twice: one capture. A late
  success arrives after `UNKNOWN`: `ISSUED`, one capture. A late success after `RELEASED`: `NEEDS_REVIEW`
  and an alert, no coin movement. A late rejection after `COMPLETED`: `NEEDS_REVIEW`, no coin movement.
- **Repeated compensation.** `ReleaseHold` delivered three times: one release, balance restored once.
  `RefundCapture` delivered three times: one refund transaction.
- **Mutations the reviewer re-applies:** release on timeout instead of `UNKNOWN` (the late-success test
  goes red with a reward issued and coins returned); call the adapter before recording `ISSUING`
  (boundary 4 test goes red with two rewards); remove the inbox dedupe on `HoldCaptured` (the duplicate
  callback test goes red); allow `CaptureHold` after `RELEASED` (conservation goes red).

## Notes

Payments is the only writer of coins (owner decision: all coin operations go only through payments; the
balance is readable everywhere). Retries and the inquiry schedule are MIO-068; the status API is MIO-067;
Part C proofs are MIO-142 to MIO-145.
