---
id: MIO-175
title: Role prompts in `prompts/` (minimal variant)
epic: EPIC-16
priority: P3
money_impact: none
risk_class: none
status: todo
depends_on: [MIO-172]
size: S
---

## Goal

Keep the role instructions as files in the repo, so briefs reference them by path instead of restating them.

## Scope

- `prompts/README.md`
- `prompts/roles/{coordinator,spec-author,test-author,coder,reviewer,re-reviewer,docs-author}.md`
- `prompts/briefs/{task,review,re-review}.md`
- `prompts/templates/{evidence-table,review-log}.md`
- Each file has a version line and a placeholders table.

## Acceptance criteria

- The reviewer prompt requires: regression test at the choke point before any fix, one mutation per
  claimed fix re-applied by the reviewer, a reader test for every new durable record, re-running the
  author's numbers.
- The re-review brief's first question is "what did this fix move?".

## Notes

Low priority; can be done later. The process already works from `AGENTS.md` and `docs/ai/process.md`.
