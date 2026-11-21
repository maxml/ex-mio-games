---
id: MIO-134
title: "Embedding: launch the widget from a casino page with a launch token"
epic: EPIC-13
priority: P1
money_impact: direct
risk_class: identity
status: todo
depends_on: [MIO-044, MIO-130]
size: M
---

## Goal

A casino adds the widget to its site with a few lines.

## Scope

- Script snippet that opens the widget in an iframe with the casino's signed launch token.
- Allowed parent origins configured per tenant (`frame-ancestors`); `postMessage` with origin checks.
- Simulator pages for Casino A and Casino B embed the widget.

## Acceptance criteria

- Embedding from an origin not on the tenant's list is blocked by the browser (end-to-end test).
- A `postMessage` from an unexpected origin is ignored.
- `docs/integrations/embedding.md` shows the snippet and the token format.
