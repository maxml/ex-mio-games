---
id: MIO-125
title: Visual regression and accessibility checks on stories
epic: EPIC-12
priority: P2
money_impact: enabler
risk_class: none
status: todo
depends_on: [MIO-123]
size: S
---

## Goal

Design does not break silently, and screens are usable by everyone.

## Scope

Story snapshots compared in CI; automated accessibility checks (axe) on every story.

## Acceptance criteria

- An unintended visual change fails CI with a diff image.
- A story with a contrast or label violation fails CI.
