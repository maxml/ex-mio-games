---
id: MIO-020
title: Add archify as a git submodule in `tools/archify`
epic: EPIC-03
priority: P2
money_impact: none
risk_class: none
status: needs-owner-review
depends_on: []
size: S
estimate_hours_base: 3
estimate_hours: 4
---

## Goal

Make the archify CLI available in the repo at a pinned version, without copying its code.

## Scope

- `git submodule add https://github.com/tt-a1i/archify tools/archify`, pinned to a release tag.
- `pnpm arch:validate`, `pnpm arch:deliver`, `pnpm arch:compare` scripts that call the submodule's CLI.
- README note: `git clone --recurse-submodules`, or `git submodule update --init`.

## Acceptance criteria

- On a fresh clone with submodules, `pnpm arch:validate` runs and exits 0 on an empty IR set.
- The submodule pin is a tag or commit, never a branch.
- The licence of archify (Apache-2.0) is noted in `docs/architecture/README.md`.

## Notes

The owner reviews the archify tasks before work starts.
