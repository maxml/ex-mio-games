---
id: MIO-211
title: Migration post-condition runs unconditionally and every shipped migration is pinned by hash
epic: EPIC-14
priority: P1
money_impact: none
risk_class: guard
status: todo
depends_on: [MIO-006, MIO-013]
size: S
estimate_hours_base: 6
estimate_hours: 8
---

## Goal

A migration run that leaves a shipped migration pending exits non-zero, and a shipped migration can never
be edited without a test turning red.

## Scope

- The migrate runner calls the data source's `showMigrations()` unconditionally. A source without the
  method fails the run instead of skipping the check.
- The immutability test pins every migration file by hash. Remove the prefix exemption that skips the files
  of the latest round; a migration file that is not in the list fails the test.
- Add a note to the contributor docs: a new migration is added to the list in the same change.

## Acceptance criteria

- A test with a data source object that has no `showMigrations` method exits 1 (not 0).
- A test with a source that reports a pending shipped migration after the run exits 1; a clean run exits 0.
- A migration file missing from the pinned list turns the immutability test red, and so does editing any
  one file (the test is run for the newest migration, not only for old ones).
- The size of the expected list is not derived from the directory it checks (a new file without an entry
  fails; the test does not recompute its expectation from the files).
- Mutation: restore the `if (source.showMigrations && ...)` guard, and the first test goes red; edit the
  newest migration, and the immutability test goes red.

## Notes

Source: the second re-review of the fix round (findings F4: the guard is still fail-open by construction;
F5: the test exempted the files of the round it was written in, so editing one turned nothing red).
