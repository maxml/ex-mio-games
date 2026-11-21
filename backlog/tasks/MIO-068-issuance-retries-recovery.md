---
id: MIO-068
title: Issuance retries, backoff, timeout handling, DLQ and replay
epic: EPIC-07
priority: P1
money_impact: direct
risk_class: concurrency
status: todo
depends_on: [MIO-066, MIO-053]
size: M
---

## Goal

External API timeouts and transient failures end in a correct final state without human help.

## Scope

- Client timeout per adapter call; a timeout moves the redemption to `UNKNOWN`, never to `REJECTED`
  (transition table in MIO-066).
- From `UNKNOWN`: query the casino status first with `getRewardStatus(redeem:{redemption_id})`, our own
  key, using the adapter's declared recovery mode (MIO-050), so recovery works even if the casino's
  reference was in the lost reply; retry issuance only on `not_found`, always with the same key and the
  frozen reward mapping.
- Exponential backoff with jitter and a cap of 8 attempts per redemption; after the cap, or 24 hours in
  `UNKNOWN`, the redemption goes to `NEEDS_REVIEW` and the job goes to the DLQ with an alert and a
  `replay` command. Coins stay held throughout: no automatic release or capture on an unknown outcome.
- Classification is a fixed table per adapter: retryable (timeout, 5xx, network, 429), final rejection
  (the adapter's business rejection codes), and unknown (anything unparseable, treated as retryable).
- Recovery path: on start-up, a sweeper picks up every redemption in `RESERVED`, `ISSUING` or `UNKNOWN`
  whose next attempt time has passed; nothing depends on an in-memory timer surviving a restart.

## Acceptance criteria

- Simulator `timeout` fault (reward issued on the casino side): final `COMPLETED`, exactly one reward in
  the simulator.
- Simulator `dropReply` on Casino B (reward issued, the reply carrying the ticket lost): recovery by our
  key finds the ticket, final `COMPLETED`, one reward.
- Simulator `error500` twice then success: final `COMPLETED` after three attempts.
- Attempts exhausted: message in DLQ, redemption `NEEDS_REVIEW` with coins still held (not released),
  alert raised; `replay` after the fault clears ends `COMPLETED`.
- Restart during backoff: after restart the sweeper resumes the redemption and it ends `COMPLETED` once.
- A rejection code missing from the adapter's final list is treated as retryable, never as final
  (test with an unknown code).
