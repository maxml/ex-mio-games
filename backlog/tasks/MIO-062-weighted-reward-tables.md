---
id: MIO-062
title: Weighted reward tables, versioned and validated
epic: EPIC-07
priority: P0
money_impact: direct
risk_class: guard
status: todo
depends_on: [MIO-032, MIO-045]
size: S
---

## Goal

Operators configure what the wheel can give and how often.

## Scope

- Table: segments with `weight` (positive integer), reward (`coins: N` or `nothing`), label.
- Versioned and immutable once published; spins reference the exact version.
- Expected value per spin and the probability of each segment computed and shown to the operator.

## Acceptance criteria

- A table with a zero, negative or non-integer weight, or no segments, is rejected with 422.
- Editing a published table creates a new version; old spins still resolve against their version.
- The player API returns segment labels for drawing the wheel but never the weights.
