---
id: MIO-057
title: Shared adapter contract test suite
epic: EPIC-06
priority: P1
money_impact: enabler
risk_class: guard
status: todo
depends_on: [MIO-050]
size: S
---

## Goal

Ten operators without ten codebases: every adapter proves the same behaviour with the same tests.

## Scope

One parameterised suite run against every registered adapter and its simulator: signature accept and
reject, timestamp window, schema rejection, mapping to canonical event, integer amounts, reward issue with
idempotency key, status query, timeout classification (`unknown`, not `failed`), final rejection
classification.

## Acceptance criteria

- The suite runs for adapters A and B in CI.
- A new adapter is not registered until the suite passes for it (registry test).
- `docs/integrations/adding-a-casino.md` explains how to add an adapter, with the suite as the checklist.

## Notes

Assignment Part E question 2.
