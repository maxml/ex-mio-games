---
id: MIO-027
title: Mermaid copies for GitHub
epic: EPIC-03
priority: P2
money_impact: none
risk_class: none
status: needs-owner-review
depends_on: [MIO-021, MIO-022]
size: S
---

## Goal

archify renders HTML and PNG, not Mermaid. GitHub readers need diagrams that render inline.

## Scope

- Mermaid versions of the container view, the 8-step sequence and the redemption lifecycle, in the
  Markdown docs.
- A check that the Mermaid node list matches the IR node list (part of MIO-026's script).

## Acceptance criteria

- The Mermaid diagrams render on GitHub (Mermaid CLI in CI).
- Removing a node from the IR without removing it from the Mermaid copy fails CI.

## Notes

The owner reviews the archify tasks before work starts.
