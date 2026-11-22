---
id: MIO-177
title: Prompt evals
epic: EPIC-16
priority: P3
money_impact: none
risk_class: none
status: todo
depends_on: [MIO-176]
size: M
estimate_hours_base: 20
estimate_hours: 24
---

## Goal

A new prompt version merges only if it is not worse than the previous one.

## Scope

- Datasets per role with development and held-out splits.
- Metrics: reviewer finds seeded defects and reports nothing on clean diffs; test author's tests are red
  on the base and green on the reference; coder goes green without touching tests.
- Results committed to `evidence/prompt-evals/` with the prompt change.

## Acceptance criteria

- CI blocks a prompt change whose held-out score is lower than the current version's.

## Notes

Low priority; can be done later.
