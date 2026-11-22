---
id: MIO-025
title: 'CI: validate, deliver, fail on diff'
epic: EPIC-03
priority: P2
money_impact: none
risk_class: none
status: needs-owner-review
depends_on: [MIO-021]
size: S
---

## Goal

Invalid IR, or IR that was changed without re-rendering, turns CI red.

## Scope

- CI step: `pnpm arch:validate && pnpm arch:deliver && git diff --exit-code docs/architecture`.
- On pull requests that change IR: `pnpm arch:compare base head` and attach the architecture-delta page
  as a build artifact for the reviewer.

## Acceptance criteria

- A pull request that edits an IR file without re-rendering fails.
- A pull request with an invalid IR file fails with the validator's message.

## Notes

The owner reviews the archify tasks before work starts.
