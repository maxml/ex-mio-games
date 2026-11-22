---
id: MIO-190
title: 'Part E5: smallest realistic team to build the MVP in six months'
epic: EPIC-17
priority: P1
money_impact: enabler
risk_class: none
status: todo
depends_on: [MIO-187, MIO-183]
size: S
estimate_hours_base: 6
estimate_hours: 8
---

## Goal

Answer Part E question 5 with explicit assumptions, so the reader can check the arithmetic.

## Scope

Section 5 of `docs/scaling.md`:

- MVP scope for six months, stated as a list (what is in, what is out), consistent with MIO-187's
  milestones.
- Staffing assumptions: working weeks, share of time lost to support and meetings, how much AI-assisted
  work changes throughput and how that number was measured on this project (not assumed).
- Roles with capacity per month (for example: founding engineer, backend engineer, frontend engineer with
  design skills, part-time QA or SRE, part-time product owner), why each is needed, and which role can be
  dropped and at what cost.
- A month-by-month allocation of the roles to the scope, and the main risk to the six-month date.

## Acceptance criteria

- The first sentence answers the question directly (a number of people and the roles).
- The capacity in person-months covers the scope estimate, and both numbers are shown.
- The AI throughput assumption links to measured data from the evidence log (MIO-173), or is labelled as
  an assumption.
