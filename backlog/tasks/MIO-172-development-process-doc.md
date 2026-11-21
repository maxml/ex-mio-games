---
id: MIO-172
title: Development process write-up
epic: EPIC-16
priority: P1
money_impact: none
risk_class: none
status: todo
depends_on: []
size: S
---

## Goal

Assignment Part D: show how AI was used to plan, write code, write tests, review and fix defects, and
which decisions were made by people.

## Scope

`docs/ai/process.md`, in plain words:

- A coordinator writes the task brief and records the task's risk class. It does not write product code.
- A spec author writes the specification and the acceptance criteria.
- A test author writes failing tests first, from the spec, without seeing the implementation.
- A coder makes the tests pass without changing them.
- An independent reviewer, on a stronger model and in a fresh session, reads the code and requirements
  (not the author's conclusions), writes regression tests at the choke point before any fix, and
  re-applies one mutation per claimed fix to see the test go red.
- On re-review the first question is "what did this fix move?".
- Documentation is updated in the same merge. Merge happens after review and green tests.
- What people decide: product priorities, architecture one-way doors, risk classes, and acceptance.

## Acceptance criteria

- The write-up links at least one real pull request for each step as an example.
- It lists the human decisions with dates and links to ADRs.
