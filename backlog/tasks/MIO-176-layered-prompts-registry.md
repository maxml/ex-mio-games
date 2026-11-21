---
id: MIO-176
title: Layered prompts and a prompt registry
epic: EPIC-16
priority: P3
money_impact: none
risk_class: none
status: todo
depends_on: [MIO-175]
size: M
---

## Goal

Prompts that are composed from layers and versioned, so a change to one layer is traceable.

## Scope

- Layers: role core (stack-free), language, framework, tool adapter, task (the only input slot).
- `prompts/registry.json`: role to version, layers, model.
- `tools/prompts/compose.ts` producing the final prompt and a signature `role/vN@sha8`, recorded in
  commit trailers.

## Acceptance criteria

- A CI check fails if an input placeholder appears outside the task layer or if a role core mentions a
  specific stack.
- A golden snapshot test of each composed prompt.

## Notes

Low priority; can be done later.
