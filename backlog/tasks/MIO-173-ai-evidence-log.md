---
id: MIO-173
title: AI development evidence log
epic: EPIC-16
priority: P1
money_impact: none
risk_class: none
status: todo
depends_on: [MIO-172]
size: M
estimate_hours_base: 12
estimate_hours: 15
---

## Goal

Deliverable "short AI-development evidence log" and Part D "evidence of AI-generated changes".

## Scope

`docs/ai/evidence-log.md`, one row per significant change: task id, what AI did (plan, code, tests,
review, fix), the agent instructions used, the commit or pull request, review findings, the mutation table
(guard, mutation, test that went red), what a person changed or rejected, and how the output was verified.

## Acceptance criteria

- At least one example each of: AI planning, AI code generation, AI test creation, AI review that found a
  real defect, and the fix with its mutation evidence.
- Every commit or pull request link in the log resolves.
- A section "Decisions made by people" and a section "How AI output was verified".
- **One fully traced example, defect to verification:** a real defect found by an AI reviewer, with links
  in order: the review finding; the regression test the reviewer wrote before the fix, and its red run;
  the AI-generated change that fixed it (commit); the green run; the reviewer re-applying the defect as a
  mutation and the test going red again; and the person's acceptance. Each link resolves.
- All prompts, transcripts and evaluation outputs in the log are sanitized exports, never raw agent
  output, and pass the pre-publication inspection (MIO-192).
