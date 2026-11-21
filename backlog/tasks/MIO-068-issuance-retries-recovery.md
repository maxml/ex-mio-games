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

- Client timeout per adapter call; a timeout moves the redemption to `UNKNOWN`, never to `FAILED`.
- From `UNKNOWN`: query the casino status first; retry issuance only if the casino has no record, always
  with the same idempotency key.
- Exponential backoff with jitter, attempt cap, then DLQ with an alert and a `replay` command.
- Transient errors (5xx, network) retry; business rejections are final.

## Acceptance criteria

- Simulator `timeout` fault (reward issued on the casino side): final `ISSUED`, exactly one reward in the simulator.
- Simulator `error500` twice then success: final `ISSUED` after three attempts.
- Attempts exhausted: message in DLQ, redemption stays `UNKNOWN` (not refunded), alert raised; `replay`
  after the fault clears ends `ISSUED`.
