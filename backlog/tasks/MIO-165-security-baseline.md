---
id: MIO-165
title: 'Security baseline: SECURITY.md, dependency review, static analysis'
epic: EPIC-15
priority: P2
money_impact: enabler
risk_class: none
status: todo
depends_on: [MIO-006]
size: S
---

## Goal

Assignment Part A: security, at the level a public repository and an early SaaS need.

## Scope

`SECURITY.md` (how to report), dependency review and automated dependency updates, static analysis in CI,
secure HTTP headers on the web app, strict TypeScript and type-aware lint (no floating promises).

## Acceptance criteria

- A pull request adding a dependency with a known critical vulnerability fails CI.
- The web app's response headers pass a header check test (CSP, HSTS, frame-ancestors, no-sniff).
