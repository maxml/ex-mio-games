---
id: MIO-069
title: 'Wheel fairness: seed management and the anti-manipulation write-up'
epic: EPIC-07
priority: P1
money_impact: enabler
risk_class: guard
status: todo
depends_on: [MIO-063]
size: S
estimate_hours_base: 8
estimate_hours: 10
---

## Goal

Answer the Part C question: how we prevent players from manipulating reward probabilities or triggering
unauthorized spins.

## Scope

- Server seeds per tenant, versioned, rotated on a schedule; the hash of each seed is published before use
  and the seed after retirement, so outcomes can be audited.
- `docs/fairness.md`: the client sends no weights, outcome or randomness; spins require an owned
  `available` credit consumed atomically; credits only come from verified casino events through rules;
  tables are versioned and server-side; rate limits; audit trail.
- Note on what we do not do: no third-party RNG certification in the prototype.

## Acceptance criteria

- An audit script recomputes every spin of a retired seed version and finds zero mismatches.
- Each claim in `docs/fairness.md` names the test that proves it (existing tests from MIO-063; the Part C
  manipulation tests add their links when they land).
