---
id: MIO-174
title: 'Workflow configuration: agent wrappers, PR template with AI provenance'
epic: EPIC-16
priority: P2
money_impact: none
risk_class: none
status: todo
depends_on: [MIO-170]
size: S
estimate_hours_base: 8
estimate_hours: 10
---

## Goal

Part D asks for "representative agent instructions and workflow configurations".

## Scope

- `.claude/agents/` thin wrappers per role with tool limits (the test author cannot edit implementation
  files; the coder cannot edit test files; the reviewer writes tests but no product code).
- `.github/pull_request_template.md` with an AI provenance block: roles and models used, review rounds,
  link to the mutation table.

## Acceptance criteria

- Each wrapper names the files it may write; a check script verifies the wrappers' allow-lists do not overlap
  where the process says they must not.
- Pull requests opened after this task use the template (spot-check of the next three PRs).
