---
id: MIO-143
title: "Part C: external API timeouts"
epic: EPIC-14
priority: P1
money_impact: direct
risk_class: concurrency
status: todo
depends_on: [MIO-068, MIO-053]
size: S
---

## Goal

Prove that a timeout never causes a double reward or a lost reward.

## Acceptance criteria

- Simulator `timeout` with the reward actually issued on the casino side: final status `ISSUED`, exactly
  one reward in the simulator, coins captured once.
- Simulator `timeout` with nothing issued: after the status query, issuance is retried with the same key
  and ends `ISSUED` once.
- During `UNKNOWN`, the coins stay reserved (not refunded, not captured).
- Mutation: treat timeout as failure, then the first test goes red (reward issued and coins refunded).
