---
id: EPIC-03
title: Diagrams as code with archify
priority: P2
status: needs-owner-review
---

# EPIC-03 Diagrams as code with archify

## Goal

Architecture diagrams are generated from a typed description kept in the repo, validated in CI and
checked against the real code, so they cannot silently go stale. Mermaid copies keep them readable on GitHub.

## Status

The owner reviews the archify tasks before work starts. Every task in this epic is `needs-owner-review`.

## Tasks

| ID      | Title                                                                   | Priority |
| ------- | ----------------------------------------------------------------------- | -------- |
| MIO-020 | Add archify as a git submodule in `tools/archify`                       | P2       |
| MIO-021 | Architecture IR: system context and containers                          | P2       |
| MIO-022 | Workflow and sequence diagrams: the 8-step flow and the redemption saga | P2       |
| MIO-023 | ERD: ledger and tenants                                                 | P2       |
| MIO-024 | Lifecycle diagram: redemption status                                    | P2       |
| MIO-025 | CI: validate, deliver, fail on diff                                     | P2       |
| MIO-026 | Drift check: IR against Nx project graph, compose and contracts         | P2       |
| MIO-027 | Mermaid copies for GitHub                                               | P2       |

## Notes

archify does not parse code. An agent writes the JSON IR and the CLI validates and renders it. The drift
check (MIO-026) is what keeps the IR honest.
