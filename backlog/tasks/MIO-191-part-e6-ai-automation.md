---
id: MIO-191
title: "Part E6: which parts of the development process to automate with AI"
epic: EPIC-17
priority: P1
money_impact: enabler
risk_class: none
status: todo
depends_on: [MIO-172, MIO-173]
size: S
estimate_hours_base: 6
estimate_hours: 8
---

## Goal

Answer Part E question 6 from what was done on this project, not from general claims.

## Scope

Section 6 of `docs/scaling.md`: a table with one row per process step (spec drafting, failing-test
drafting, code, review with mutation evidence, adapter scaffolding from a casino's API documentation,
sample generation, release notes, DLQ and `NEEDS_REVIEW` triage, documentation drift checks). Columns:
automate now, automate later, or keep human; the human check that stays; the evidence from this project
(link to the evidence log or a pull request); the risk if the check is skipped.

## Acceptance criteria

- The first sentence answers the question directly.
- Every "automate now" row links at least one real example from MIO-173.
- Every row names the human decision or check that remains (consistent with the table in MIO-172).
