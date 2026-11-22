---
id: EPIC-16
title: AI-native development and AI-readiness (assignment Part D)
priority: P1
status: todo
---

# EPIC-16 AI-native development and AI-readiness

## Goal

The repository is easy for AI agents to work in, and it shows how AI was used to plan, write code,
write tests, review and fix defects, with the human decisions and the verification made explicit.

## Tasks

| ID | Title | Priority |
|---|---|---|
| MIO-170 | `AGENTS.md`, `CLAUDE.md`, `memory/`, docs index | P1 |
| MIO-171 | `CONTRACTS.md`: one place for every contract | P1 |
| MIO-172 | Development process write-up | P1 |
| MIO-173 | AI development evidence log | P1 |
| MIO-174 | Workflow configuration: agent wrappers, PR template with AI provenance | P2 |
| MIO-175 | Role prompts in `prompts/` (minimal variant) | P3 |
| MIO-176 | Layered prompts and a prompt registry | P3 |
| MIO-177 | Prompt evals | P3 |
| MIO-178 | Self-improvement of prompts from review defects | P3 |
| MIO-179 | Prompt security check | P3 |

## Note on prompt tasks

MIO-175 to MIO-179 are low priority. They can be done later; the process works today with the role
rules written in `AGENTS.md` and the process write-up.
