---
id: MIO-178
title: Self-improvement of prompts from review defects
epic: EPIC-16
priority: P3
money_impact: none
risk_class: none
status: todo
depends_on: [MIO-177]
size: M
---

## Goal

Defects found in review make the prompts better, so the same class of defect is not produced twice.

## Scope

- Each confirmed review finding is tagged with a defect class and the role that should have caught or
  prevented it.
- A periodic job proposes a prompt change per recurring class and adds the defect as an eval case.
- A person approves the change; it merges only through MIO-177's eval check.

## Acceptance criteria

- A recurring defect class (three or more findings) produces a proposed change with the new eval cases.
- The eval case reproduces the defect with the old prompt and passes with the new one.

## Notes

Low priority; can be done later.
