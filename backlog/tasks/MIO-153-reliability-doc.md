---
id: MIO-153
title: '`docs/reliability.md`: each case, its test, how to run it'
epic: EPIC-14
priority: P1
money_impact: none
risk_class: none
status: todo
depends_on:
  [
    MIO-140,
    MIO-141,
    MIO-142,
    MIO-143,
    MIO-144,
    MIO-145,
    MIO-146,
    MIO-147,
    MIO-148,
    MIO-149,
    MIO-150,
    MIO-151,
    MIO-154,
  ]
size: S
---

## Goal

A reviewer sees how the system handles each Part C case and can run the proof.

## Scope

One section per Part C case: the mechanism (constraint, conditional update, idempotency key, saga state,
RLS), the test file and name, the mutation that turns it red, and the command to run it. Plus how
`pnpm demo --faults` shows the same cases live.

## Acceptance criteria

- Every Part C bullet has a section with a link to an existing test.
- A CI check fails if a linked test file or test name no longer exists.
