---
id: MIO-170
title: "`AGENTS.md`, `CLAUDE.md`, `memory/`, docs index"
epic: EPIC-16
priority: P1
money_impact: enabler
risk_class: none
status: todo
depends_on: []
size: S
estimate_hours_base: 6
estimate_hours: 8
---

## Goal

Any AI agent (and any new engineer) finds the rules, the architecture and the commands in one minute.

## Scope

- `AGENTS.md`: what the product is, the principles, commands, layout, layering rules, testing rules,
  the development process, what not to touch. `CLAUDE.md` points to `AGENTS.md`.
- `memory/projectBrief.md` (product principles, users, non-goals, success criteria),
  `memory/systemPatterns.md` (patterns used: outbox, inbox, idempotency keys, sagas, RLS).
- `docs/README.md` indexing all docs; `docs/status.md` for current status (MIO-186).

## Acceptance criteria

- Every path and command mentioned in `AGENTS.md` exists and runs (link and command check in CI).
- `memory/projectBrief.md` contains the four product principles from `backlog/README.md`.
