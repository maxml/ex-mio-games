---
id: MIO-179
title: Prompt security check
epic: EPIC-16
priority: P3
money_impact: none
risk_class: guard
status: todo
depends_on: [MIO-176]
size: S
estimate_hours_base: 8
estimate_hours: 10
---

## Goal

Prompts and their inputs cannot be used to make an agent leak data or step outside its role.

## Scope

- Inputs to prompts are fenced with a random marker; text inside the fence is data, never instructions.
- A CI check scans prompt files for secrets, private paths and instructions to disable checks.
- Injection eval cases (a task description that tells the reviewer to approve) in MIO-177's datasets.

## Acceptance criteria

- The injection eval cases pass (the agent does not follow instructions inside the input).
- A prompt file containing a secret-like string fails CI.

## Notes

Low priority; can be done later.
