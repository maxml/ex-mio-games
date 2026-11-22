---
id: MIO-057
title: Shared adapter contract test suite (written before the first adapter)
epic: EPIC-06
priority: P0
money_impact: enabler
risk_class: guard
status: todo
depends_on: [MIO-050]
size: S
estimate_hours_base: 8
estimate_hours: 10
---

## Goal

Ten operators without ten codebases: every adapter proves the same behaviour with the same tests. The
suite is written from the interface in MIO-050 before any adapter exists and is red until an adapter
makes it green.

## Scope

One parameterised suite run against every registered adapter and its simulator: signature accept and
reject (including malformed signatures), timestamp window, schema rejection, mapping to canonical event,
integer amounts, reward issue with idempotency key, status lookup by our key, the "effect done, reply
with the external id lost" case (through a test transport that drops the reply), timeout classification
(`unknown`, not a rejection), final rejection classification.

## Acceptance criteria

- The suite exists and fails against a stub adapter before any real adapter is written, and passes
  against the in-memory reference adapters from MIO-050.
- It runs in CI for every registered adapter, enumerated from the registry.
- A new adapter is not registered until the suite passes for it (registry test).
- `docs/integrations/adding-a-casino.md` explains how to add an adapter, with the suite as the checklist.

## Notes

Assignment Part E question 2. Casino A (MIO-051) and Casino B (MIO-052) each depend on this suite and
must pass it.
