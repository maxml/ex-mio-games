---
id: MIO-143
title: 'Part C: external API timeouts'
epic: EPIC-14
priority: P1
money_impact: direct
risk_class: concurrency
status: todo
depends_on: [MIO-068, MIO-053]
size: S
estimate_hours_base: 8
estimate_hours: 10
---

## Goal

Prove that a timeout never causes a double reward or a lost reward.

## Acceptance criteria

- Simulator `timeout` with the reward actually issued on the casino side (the ambiguous result): final
  status `COMPLETED`, exactly one reward in the simulator, coins captured once.
- Simulator `timeout` with nothing issued: after the status query, issuance is retried with the same key
  and ends `COMPLETED` once.
- During `UNKNOWN`, the coins stay held (not released, not captured).
- The casino stays unreachable past the maximum age: `NEEDS_REVIEW`, coins still held, alert raised.
- Mutation: treat timeout as a final rejection, then the first test goes red (reward issued and coins
  released).
